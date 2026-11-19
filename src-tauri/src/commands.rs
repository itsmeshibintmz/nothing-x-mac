// Commands the web view calls (see web/platform/nx.js).

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::{bridge::Bridge, platform, popover, tray, AUTHOR_URL};

#[derive(Serialize)]
pub struct InitInfo {
    /// "macos" or "windows"; the UI styles itself per platform.
    platform: &'static str,
    /// System accent colour as #rrggbb.
    accent: String,
    /// System symbols as image data URLs, used as CSS masks.
    symbols: BTreeMap<&'static str, Option<String>>,
}

#[tauri::command]
pub fn init() -> InitInfo {
    InitInfo {
        platform: platform::NAME,
        accent: platform::accent_color(),
        symbols: platform::symbols(),
    }
}

/// Keeps the window as tall as the panel's content.
#[tauri::command]
pub fn set_height(window: WebviewWindow, height: f64) {
    popover::set_height(&window, height);
}

#[tauri::command]
pub fn set_tooltip(app: AppHandle, text: String) {
    tray::set_tooltip(&app, &text);
}

#[tauri::command]
pub fn open_author(app: AppHandle) {
    if let Err(err) = app.opener().open_url(AUTHOR_URL, None::<&str>) {
        eprintln!("[shell] could not open {AUTHOR_URL}: {err}");
    }
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// The connected earbuds ({ name, address }), or null.
#[tauri::command]
pub fn bridge_connection(bridge: State<Bridge>) -> Option<Value> {
    bridge.connection()
}

/// Sends raw bytes (hex) to the earbuds.
#[tauri::command]
pub fn bridge_write(bridge: State<Bridge>, hex: String) {
    bridge.write(&hex);
}
