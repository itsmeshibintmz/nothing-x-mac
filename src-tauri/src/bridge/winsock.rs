// Windows transport: opens the earbuds' control channel itself.
//
// The earbuds expose a serial-style service (RFCOMM) with a fixed id. Windows'
// Bluetooth sockets can connect to a paired device by that service id, so no
// separate helper program is needed:
//   1. list paired audio devices that are connected right now,
//   2. try to open the service on each; the first that answers is the earbuds,
//   3. relay bytes until the channel closes, then look again.
//
// A device that doesn't open the service is retried less and less often, so
// someone's other headphones aren't probed every few seconds.

use std::{
    collections::HashMap,
    mem::size_of,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use windows::{
    core::GUID,
    Win32::{
        Devices::Bluetooth::{
            BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindNextDevice, AF_BTH,
            BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS, BTHPROTO_RFCOMM, SOCKADDR_BTH,
        },
        Foundation::HANDLE,
        Networking::WinSock::{
            closesocket, connect, recv, send, shutdown, socket, WSAGetLastError, WSAStartup,
            SD_BOTH, SEND_RECV_FLAGS, SOCKADDR, SOCKET, SOCK_STREAM, WSADATA,
        },
    },
};

use super::transport::{Events, Transport};

/// Nothing / CMF control service (the same id the macOS helper uses).
const SERVICE_ID: GUID = GUID::from_u128(0xAEAC4A03_DFF5_498F_843A_34487CF133EB);
const SCAN_INTERVAL: Duration = Duration::from_secs(3);
/// Longest wait between attempts on a device that keeps refusing. A device
/// named like Nothing / CMF earbuds is probably just busy (the phone app holds
/// the channel), so it is retried often; anything else is probably some other
/// headset that will never answer.
const RETRY_CAP_EARBUDS: Duration = Duration::from_secs(15);
const RETRY_CAP_OTHER: Duration = Duration::from_secs(10 * 60);
/// Frames waiting to be sent; more than this means the link is stuck.
const OUTBOX_SIZE: usize = 64;
/// Bluetooth "major device class" for audio/video devices (earbuds, headphones).
const MAJOR_CLASS_AUDIO: u32 = 0x04;
/// Winsock 2.2.
const WINSOCK_VERSION: u16 = 0x0202;
const NO_SOCKET: usize = usize::MAX;

struct Shared {
    /// The open channel's socket, or NO_SOCKET. Whoever swaps it out closes it.
    socket: AtomicUsize,
    stopping: AtomicBool,
    /// Held while sending, and while freeing the socket, so a send never
    /// touches a handle that was already closed.
    sending: Mutex<()>,
}

pub struct WinsockTransport {
    shared: Arc<Shared>,
    /// Frames queued for the writer thread.
    outbox: SyncSender<Vec<u8>>,
}

struct Device {
    address: u64,
    name: String,
}

/// How a device that refused the service is being retried.
struct Retry {
    failures: u32,
    next_attempt: Instant,
}

pub fn start(events: Arc<dyn Events>) -> WinsockTransport {
    let shared = Arc::new(Shared {
        socket: AtomicUsize::new(NO_SOCKET),
        stopping: AtomicBool::new(false),
        sending: Mutex::new(()),
    });
    let (outbox, frames) = sync_channel(OUTBOX_SIZE);

    let reader = shared.clone();
    thread::spawn(move || run(&reader, events.as_ref()));
    let writer = shared.clone();
    thread::spawn(move || send_frames(&writer, &frames));

    WinsockTransport { shared, outbox }
}

impl Transport for WinsockTransport {
    /// Queues the bytes and returns at once. Sending can block when the link
    /// stalls, and this is called from the app's main thread.
    fn write(&self, bytes: &[u8]) {
        if self.shared.socket.load(Ordering::SeqCst) != NO_SOCKET {
            // A full queue means the link is stuck; dropping the frame is fine,
            // the page re-reads settings it didn't get confirmed.
            let _ = self.outbox.try_send(bytes.to_vec());
        }
    }

    fn stop(&self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        close(&self.shared); // also unblocks the read loop
    }
}

/// Closes the open socket, if any. Safe to call from any thread, any number of times.
fn close(shared: &Shared) {
    let raw = shared.socket.swap(NO_SOCKET, Ordering::SeqCst);
    if raw != NO_SOCKET {
        // Shutting down first unblocks a send or receive in progress; the
        // handle is only freed once no send is using it.
        unsafe { shutdown(SOCKET(raw), SD_BOTH) };
        let _sending = shared.sending.lock().unwrap();
        unsafe { closesocket(SOCKET(raw)) };
    }
}

/// Writer thread: sends queued frames, one at a time, to the open channel.
fn send_frames(shared: &Shared, frames: &Receiver<Vec<u8>>) {
    for frame in frames {
        let _sending = shared.sending.lock().unwrap();
        let raw = shared.socket.load(Ordering::SeqCst);
        if raw == NO_SOCKET {
            continue; // disconnected while the frame was queued
        }
        let mut rest = frame.as_slice();
        while !rest.is_empty() {
            let sent = unsafe { send(SOCKET(raw), rest, SEND_RECV_FLAGS(0)) };
            if sent <= 0 {
                break; // the read loop notices the broken channel
            }
            rest = &rest[sent as usize..];
        }
    }
}

fn run(shared: &Shared, events: &dyn Events) {
    let mut wsa = WSADATA::default();
    if unsafe { WSAStartup(WINSOCK_VERSION, &mut wsa) } != 0 {
        events.log("Windows sockets could not start; Bluetooth is unavailable");
        return;
    }

    // Devices that refused the service, by address, and when to try them again.
    let mut retries: HashMap<u64, Retry> = HashMap::new();
    // "Nothing to connect to" is logged once per dry spell.
    let mut reported_none = false;

    while !shared.stopping.load(Ordering::SeqCst) {
        let candidates = connected_audio_devices();
        if candidates.is_empty() {
            if !reported_none {
                events.log("No connected Bluetooth audio device found; waiting for one");
                reported_none = true;
            }
        } else {
            reported_none = false;
        }
        // A device that disconnected starts fresh when it comes back.
        retries.retain(|address, _| candidates.iter().any(|device| device.address == *address));

        if let Some((socket, device)) = connect_to_earbuds(candidates, events, &mut retries) {
            shared.socket.store(socket.0, Ordering::SeqCst);
            // `stop` may have run between connecting and storing the socket.
            if shared.stopping.load(Ordering::SeqCst) {
                close(shared);
                break;
            }
            retries.clear();
            events.connected(&device.name, &format_address(device.address));

            let mut buffer = [0u8; 1024];
            loop {
                let received = unsafe { recv(socket, &mut buffer, SEND_RECV_FLAGS(0)) };
                if received <= 0 {
                    break; // closed by the earbuds, by `stop`, or the link dropped
                }
                events.data(&buffer[..received as usize]);
            }

            close(shared);
            events.disconnected();
        }

        // Wait before looking again, but wake up quickly for `stop`.
        let mut waited = Duration::ZERO;
        while waited < SCAN_INTERVAL && !shared.stopping.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
            waited += Duration::from_millis(100);
        }
    }
}

/// Tries each candidate device that is due for an attempt until one opens the
/// service.
fn connect_to_earbuds(
    candidates: Vec<Device>,
    events: &dyn Events,
    retries: &mut HashMap<u64, Retry>,
) -> Option<(SOCKET, Device)> {
    for device in candidates {
        if retries.get(&device.address).is_some_and(|retry| Instant::now() < retry.next_attempt) {
            continue;
        }
        let Ok(socket) = (unsafe { socket(i32::from(AF_BTH), SOCK_STREAM, BTHPROTO_RFCOMM as i32) })
        else {
            continue;
        };
        // Port 0 + a service id: Windows looks up the channel on the device.
        let address = SOCKADDR_BTH {
            addressFamily: AF_BTH,
            btAddr: device.address,
            serviceClassId: SERVICE_ID,
            port: 0,
        };
        let result = unsafe {
            connect(
                socket,
                (&raw const address).cast::<SOCKADDR>(),
                size_of::<SOCKADDR_BTH>() as i32,
            )
        };
        if result == 0 {
            return Some((socket, device));
        }

        let error = unsafe { WSAGetLastError() }.0;
        unsafe { closesocket(socket) };

        let retry = retries
            .entry(device.address)
            .or_insert(Retry { failures: 0, next_attempt: Instant::now() });
        retry.failures += 1;
        retry.next_attempt = Instant::now() + retry_delay(&device.name, retry.failures);
        // Logged once per device, not on every retry.
        if retry.failures == 1 {
            events.log(&format!(
                "Could not open channel to {} ({}): Windows socket error {error}",
                device.name,
                format_address(device.address),
            ));
        }
    }
    None
}

/// Doubles from the scan interval up to a cap that depends on the device.
fn retry_delay(name: &str, failures: u32) -> Duration {
    let cap = if looks_like_earbuds(name) { RETRY_CAP_EARBUDS } else { RETRY_CAP_OTHER };
    let doubled = SCAN_INTERVAL.saturating_mul(1u32 << failures.saturating_sub(1).min(16));
    doubled.min(cap)
}

/// True for names Nothing and CMF products use ("CMF Buds 2 Plus", "Ear (a)",
/// "Nothing Headphone (1)"). Only a hint for how often to retry.
fn looks_like_earbuds(name: &str) -> bool {
    let name = name.to_lowercase();
    name.contains("nothing")
        || name.contains("cmf")
        || name.starts_with("ear ")
        || name.starts_with("ear(")
        || name.starts_with("headphone")
}

/// Paired Bluetooth devices that are connected and are audio devices.
fn connected_audio_devices() -> Vec<Device> {
    let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
        dwSize: size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
        fReturnAuthenticated: true.into(),
        fReturnRemembered: true.into(),
        fReturnUnknown: false.into(),
        fReturnConnected: true.into(),
        // Only what Windows already knows about: no radio scan.
        fIssueInquiry: false.into(),
        cTimeoutMultiplier: 0,
        hRadio: HANDLE::default(),
    };
    let blank = || BLUETOOTH_DEVICE_INFO {
        dwSize: size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
        ..Default::default()
    };

    let mut devices = Vec::new();
    let mut info = blank();
    let Ok(search) = (unsafe { BluetoothFindFirstDevice(&params, &mut info) }) else {
        return devices;
    };
    loop {
        let major_class = (info.ulClassofDevice >> 8) & 0x1f;
        if info.fConnected.as_bool() && major_class == MAJOR_CLASS_AUDIO {
            let length = info.szName.iter().position(|&c| c == 0).unwrap_or(info.szName.len());
            devices.push(Device {
                address: unsafe { info.Address.Anonymous.ullLong },
                name: String::from_utf16_lossy(&info.szName[..length]),
            });
        }
        info = blank();
        if unsafe { BluetoothFindNextDevice(search, &mut info) }.is_err() {
            break;
        }
    }
    unsafe {
        let _ = BluetoothFindDeviceClose(search);
    }
    devices
}

/// 48-bit address as AA-BB-CC-DD-EE-FF.
fn format_address(address: u64) -> String {
    let bytes = address.to_be_bytes();
    bytes[2..].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join("-")
}
