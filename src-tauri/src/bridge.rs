// Runs the native Bluetooth helper (nx-bridge) and relays its messages.
//
// The helper finds the earbuds, opens the channel and speaks JSON lines over
// stdio (see native/mac/NXBridge.swift). Its messages are forwarded to the web
// view as "bridge:message" events:
//   { type: "connected", name, address } | { type: "data", hex } | { type: "disconnected" }
// If the helper exits, it is started again after a short pause.

use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const EVENT: &str = "bridge:message";
/// Set NXM_DEBUG=1 to log every message to and from the earbuds.
const DEBUG_ENV: &str = "NXM_DEBUG";
const RESTART_DELAY: Duration = Duration::from_secs(3);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Shared {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    /// { name, address } while the earbuds are connected.
    connection: Mutex<Option<Value>>,
    stopping: AtomicBool,
}

pub struct Bridge {
    shared: Arc<Shared>,
}

/// The helper sits next to the app's executable (Tauri "externalBin").
fn helper_path() -> PathBuf {
    let name = if cfg!(windows) { "nx-bridge.exe" } else { "nx-bridge" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

impl Bridge {
    pub fn start(app: &AppHandle) -> Self {
        let shared = Arc::new(Shared::default());
        let app = app.clone();
        let worker = shared.clone();
        thread::spawn(move || supervise(&app, &worker));
        Self { shared }
    }

    pub fn connection(&self) -> Option<Value> {
        self.shared.connection.lock().unwrap().clone()
    }

    pub fn write(&self, hex: &str) {
        if debug() {
            eprintln!("[nx-bridge] -> {hex}");
        }
        self.send(&json!({ "type": "write", "hex": hex }));
    }

    /// Asks the helper to close its Bluetooth channel and exit. Killing it
    /// outright leaves the channel open on the earbuds, which blocks the next
    /// connection.
    pub fn stop(&self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        self.send(&json!({ "type": "quit" }));
        // Closing stdin (EOF) also tells the helper to shut down.
        self.shared.stdin.lock().unwrap().take();

        let deadline = Instant::now() + STOP_TIMEOUT;
        let mut child = self.shared.child.lock().unwrap();
        if let Some(child) = child.as_mut() {
            while matches!(child.try_wait(), Ok(None)) {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
    }

    fn send(&self, message: &Value) {
        if let Some(stdin) = self.shared.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, "{message}").and_then(|()| stdin.flush());
        }
    }
}

fn debug() -> bool {
    static DEBUG: OnceLock<bool> = OnceLock::new();
    *DEBUG.get_or_init(|| std::env::var_os(DEBUG_ENV).is_some())
}

fn supervise(app: &AppHandle, shared: &Shared) {
    let path = helper_path();
    while !shared.stopping.load(Ordering::SeqCst) {
        match Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
        {
            Ok(mut child) => {
                let stdout = child.stdout.take();
                *shared.stdin.lock().unwrap() = child.stdin.take();
                *shared.child.lock().unwrap() = Some(child);

                // Runs until the helper closes stdout, i.e. exits.
                if let Some(stdout) = stdout {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        on_line(app, shared, &line);
                    }
                }

                shared.stdin.lock().unwrap().take();
                if let Some(mut child) = shared.child.lock().unwrap().take() {
                    let _ = child.wait();
                }
                shared.connection.lock().unwrap().take();
                let _ = app.emit(EVENT, json!({ "type": "disconnected" }));
            }
            Err(err) => eprintln!("[nx-bridge] failed to start {}: {err}", path.display()),
        }

        if shared.stopping.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(RESTART_DELAY);
    }
}

fn on_line(app: &AppHandle, shared: &Shared, line: &str) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return;
    };
    match message["type"].as_str() {
        Some("log") => {
            eprintln!("[nx-bridge] {}", message["message"].as_str().unwrap_or_default());
            return;
        }
        Some("connected") => {
            *shared.connection.lock().unwrap() =
                Some(json!({ "name": message["name"], "address": message["address"], "modelId": message["modelId"] }));
        }
        Some("disconnected") => {
            shared.connection.lock().unwrap().take();
        }
        Some("data") if debug() => {
            eprintln!("[nx-bridge] <- {}", message["hex"].as_str().unwrap_or_default());
        }
        _ => {}
    }
    let _ = app.emit(EVENT, message);
}
