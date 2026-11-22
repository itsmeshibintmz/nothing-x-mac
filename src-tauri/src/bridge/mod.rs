// Bluetooth byte transport between the web view and the earbuds.
//
// The earbud protocol lives in the page (web/core); this only moves bytes.
// The page hears from it through "bridge:message" events:
//   { type: "connected", name, address } | { type: "data", hex } | { type: "disconnected" }
// and sends bytes with the `bridge_write` command.
//
// Each platform has its own transport behind the same interface:
//   macOS    helper.rs    runs the Swift helper (native/mac/NXBridge.swift)
//   Windows  winsock.rs   opens the RFCOMM channel itself
//
// Connection events and errors also go to a log file, because an installed
// Windows app has no terminal to print to:
//   Windows  %LOCALAPPDATA%\<app id>\logs\bluetooth.log
//   macOS    ~/Library/Logs/<app id>/bluetooth.log

#[cfg(target_os = "macos")]
mod helper;
mod transport;
#[cfg(windows)]
mod winsock;

use std::{
    fs::{self, File},
    io::Write,
    sync::{Arc, Mutex, OnceLock},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use transport::{Events, Transport};

const EVENT: &str = "bridge:message";
const LOG_FILE: &str = "bluetooth.log";
/// Set NXM_DEBUG=1 to log every message to and from the earbuds.
const DEBUG_ENV: &str = "NXM_DEBUG";

fn debug() -> bool {
    static DEBUG: OnceLock<bool> = OnceLock::new();
    *DEBUG.get_or_init(|| std::env::var_os(DEBUG_ENV).is_some())
}

pub struct Bridge {
    /// { name, address } while the earbuds are connected.
    connection: Arc<Mutex<Option<Value>>>,
    transport: Option<Box<dyn Transport>>,
}

impl Bridge {
    pub fn start(app: &AppHandle) -> Self {
        let connection = Arc::new(Mutex::new(None));
        let events: Arc<dyn Events> = Arc::new(AppEvents {
            app: app.clone(),
            connection: connection.clone(),
            log_file: Mutex::new(open_log(app)),
        });
        events.log(&format!("Bluetooth transport starting ({})", std::env::consts::OS));
        Self { connection, transport: start_transport(events) }
    }

    pub fn connection(&self) -> Option<Value> {
        self.connection.lock().unwrap().clone()
    }

    /// Sends raw bytes (as hex) to the earbuds.
    pub fn write(&self, hex: &str) {
        if debug() {
            eprintln!("[nx-bridge] -> {hex}");
        }
        if let (Some(transport), Some(bytes)) = (&self.transport, from_hex(hex)) {
            transport.write(&bytes);
        }
    }

    /// Closes the Bluetooth channel cleanly. Dropping it without this leaves
    /// the channel open on the earbuds, which blocks the next connection.
    pub fn stop(&self) {
        if let Some(transport) = &self.transport {
            transport.stop();
        }
    }
}

#[cfg(target_os = "macos")]
fn start_transport(events: Arc<dyn Events>) -> Option<Box<dyn Transport>> {
    Some(Box::new(helper::start(events)))
}

#[cfg(windows)]
fn start_transport(events: Arc<dyn Events>) -> Option<Box<dyn Transport>> {
    Some(Box::new(winsock::start(events)))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn start_transport(events: Arc<dyn Events>) -> Option<Box<dyn Transport>> {
    events.log("Bluetooth is not supported on this platform yet");
    None
}

/// Forwards transport events to the web view and remembers the connection.
struct AppEvents {
    app: AppHandle,
    connection: Arc<Mutex<Option<Value>>>,
    log_file: Mutex<Option<File>>,
}

/// Starts a fresh log for this run; None if the folder can't be written.
fn open_log(app: &AppHandle) -> Option<File> {
    let dir = app.path().app_log_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    File::create(dir.join(LOG_FILE)).ok()
}

impl Events for AppEvents {
    fn connected(&self, name: &str, address: &str) {
        *self.connection.lock().unwrap() = Some(json!({ "name": name, "address": address }));
        self.log(&format!("Connected to {name} ({address})"));
        let _ = self.app.emit(EVENT, json!({ "type": "connected", "name": name, "address": address }));
    }

    fn data(&self, bytes: &[u8]) {
        let hex = to_hex(bytes);
        if debug() {
            eprintln!("[nx-bridge] <- {hex}");
        }
        let _ = self.app.emit(EVENT, json!({ "type": "data", "hex": hex }));
    }

    fn disconnected(&self) {
        if self.connection.lock().unwrap().take().is_some() {
            self.log("Disconnected");
        }
        let _ = self.app.emit(EVENT, json!({ "type": "disconnected" }));
    }

    fn log(&self, message: &str) {
        eprintln!("[nx-bridge] {message}");
        if let Some(file) = self.log_file.lock().unwrap().as_mut() {
            let _ = writeln!(file, "{message}").and_then(|()| file.flush());
        }
    }
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 || !hex.is_ascii() {
        return None;
    }
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect()
}
