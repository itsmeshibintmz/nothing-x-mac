// macOS transport: runs the native Bluetooth helper (nx-bridge).
//
// The helper finds the earbuds, opens the channel and speaks JSON lines over
// stdio (see native/mac/NXBridge.swift):
//   stdout  {"type":"connected","name":"…","address":"…"} | {"type":"data","hex":"…"}
//           {"type":"disconnected"} | {"type":"log","message":"…"}
//   stdin   {"type":"write","hex":"…"} | {"type":"quit"}
// If the helper exits, it is started again after a short pause.

use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use super::{
    from_hex, to_hex,
    transport::{Events, Transport},
};

const RESTART_DELAY: Duration = Duration::from_secs(3);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Shared {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
}

pub struct HelperTransport {
    shared: Arc<Shared>,
}

/// The helper sits next to the app's executable (Tauri "externalBin").
fn helper_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("nx-bridge")))
        .unwrap_or_else(|| PathBuf::from("nx-bridge"))
}

pub fn start(events: Arc<dyn Events>) -> HelperTransport {
    let shared = Arc::new(Shared::default());
    let worker = shared.clone();
    thread::spawn(move || supervise(&worker, events.as_ref()));
    HelperTransport { shared }
}

impl HelperTransport {
    fn send(&self, message: &Value) {
        if let Some(stdin) = self.shared.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, "{message}").and_then(|()| stdin.flush());
        }
    }
}

impl Transport for HelperTransport {
    fn write(&self, bytes: &[u8]) {
        self.send(&json!({ "type": "write", "hex": to_hex(bytes) }));
    }

    /// Asks the helper to close its channel and exit; kills it only if it
    /// doesn't.
    fn stop(&self) {
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
}

fn supervise(shared: &Shared, events: &dyn Events) {
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
                        on_line(events, &line);
                    }
                }

                shared.stdin.lock().unwrap().take();
                if let Some(mut child) = shared.child.lock().unwrap().take() {
                    let _ = child.wait();
                }
                events.disconnected();
            }
            Err(err) => events.log(&format!("failed to start {}: {err}", path.display())),
        }

        if shared.stopping.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(RESTART_DELAY);
    }
}

fn on_line(events: &dyn Events, line: &str) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let text = |key: &str| message[key].as_str().unwrap_or_default();
    match message["type"].as_str() {
        Some("connected") => events.connected(text("name"), text("address")),
        Some("data") => {
            if let Some(bytes) = from_hex(text("hex")) {
                events.data(&bytes);
            }
        }
        Some("disconnected") => events.disconnected(),
        Some("log") => events.log(text("message")),
        _ => {}
    }
}
