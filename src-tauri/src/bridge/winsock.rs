// Windows transport: opens the earbuds' control channel itself.
//
// The earbuds expose a serial-style service (RFCOMM) with a fixed id. Windows'
// Bluetooth sockets can connect to a paired device by that service id, so no
// separate helper program is needed:
//   1. list paired audio devices that are connected right now,
//   2. try to open the service on each; the first that answers is the earbuds,
//   3. relay bytes until the channel closes, then look again.

use std::{
    collections::HashSet,
    mem::size_of,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
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
/// Bluetooth "major device class" for audio/video devices (earbuds, headphones).
const MAJOR_CLASS_AUDIO: u32 = 0x04;
/// Winsock 2.2.
const WINSOCK_VERSION: u16 = 0x0202;
const NO_SOCKET: usize = usize::MAX;

struct Shared {
    /// The open channel's socket, or NO_SOCKET. Whoever swaps it out closes it.
    socket: AtomicUsize,
    stopping: AtomicBool,
    /// Keeps frames from interleaving when two writes race.
    writing: Mutex<()>,
}

pub struct WinsockTransport {
    shared: Arc<Shared>,
}

struct Device {
    address: u64,
    name: String,
}

pub fn start(events: Arc<dyn Events>) -> WinsockTransport {
    let shared = Arc::new(Shared {
        socket: AtomicUsize::new(NO_SOCKET),
        stopping: AtomicBool::new(false),
        writing: Mutex::new(()),
    });
    let worker = shared.clone();
    thread::spawn(move || run(&worker, events.as_ref()));
    WinsockTransport { shared }
}

impl Transport for WinsockTransport {
    fn write(&self, bytes: &[u8]) {
        let _guard = self.shared.writing.lock().unwrap();
        let raw = self.shared.socket.load(Ordering::SeqCst);
        if raw == NO_SOCKET {
            return;
        }
        let mut rest = bytes;
        while !rest.is_empty() {
            let sent = unsafe { send(SOCKET(raw), rest, SEND_RECV_FLAGS(0)) };
            if sent <= 0 {
                break; // the read loop notices the broken channel
            }
            rest = &rest[sent as usize..];
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
        unsafe {
            shutdown(SOCKET(raw), SD_BOTH);
            closesocket(SOCKET(raw));
        }
    }
}

fn run(shared: &Shared, events: &dyn Events) {
    let mut wsa = WSADATA::default();
    if unsafe { WSAStartup(WINSOCK_VERSION, &mut wsa) } != 0 {
        events.log("Windows sockets could not start; Bluetooth is unavailable");
        return;
    }

    // Addresses whose failure was already logged, so a busy or unsupported
    // device doesn't fill the log every few seconds.
    let mut reported = HashSet::new();
    // Likewise, "nothing to connect to" is logged once per dry spell.
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

        if let Some((socket, device)) = connect_to_earbuds(candidates, events, &mut reported) {
            shared.socket.store(socket.0, Ordering::SeqCst);
            // `stop` may have run between connecting and storing the socket.
            if shared.stopping.load(Ordering::SeqCst) {
                close(shared);
                break;
            }
            reported.clear();
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

/// Tries each candidate device until one opens the service.
fn connect_to_earbuds(
    candidates: Vec<Device>,
    events: &dyn Events,
    reported: &mut HashSet<u64>,
) -> Option<(SOCKET, Device)> {
    for device in candidates {
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
        if reported.insert(device.address) {
            events.log(&format!(
                "Could not open channel to {} ({}): Windows socket error {error}",
                device.name,
                format_address(device.address),
            ));
        }
    }
    None
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
