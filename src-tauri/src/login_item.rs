// Open at Login.
//
// The system can only start an installed app at login, so this only works in
// the packaged app, not under `npm start`. On an installed copy's first run it
// turns itself on; after that the user's choice is kept. A copy that merely
// runs from wherever it was downloaded never signs itself up.

use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager};

use crate::platform;

const FIRST_RUN_MARKER: &str = "login-item-initialized";

pub fn is_supported() -> bool {
    !cfg!(debug_assertions) && platform::login_item_supported()
}

pub fn is_enabled() -> bool {
    is_supported() && platform::login_item_enabled()
}

pub fn set_enabled(enabled: bool) {
    if !is_supported() {
        return;
    }
    if let Err(err) = platform::set_login_item_enabled(enabled) {
        eprintln!("[login-item] could not change Open at Login: {err}");
    }
}

/// Turns Open at Login on once, the first time the installed app runs.
pub fn enable_on_first_run(app: &AppHandle) {
    if !is_supported() || !platform::is_installed_copy() {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else { return };
    let marker = dir.join(FIRST_RUN_MARKER);
    if marker.exists() {
        return;
    }
    // Someone upgrading from the Electron version already made their choice.
    if !legacy_marker(app).is_some_and(|path| path.exists()) {
        set_enabled(true);
    }
    if let Err(err) = fs::create_dir_all(&dir).and_then(|()| fs::write(&marker, "")) {
        eprintln!("[login-item] could not save first-run marker: {err}");
    }
}

/// Where the Electron version (0.1.0) kept the same marker.
fn legacy_marker(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().data_dir().ok()?;
    Some(dir.join("Nothing X Mac").join(FIRST_RUN_MARKER))
}
