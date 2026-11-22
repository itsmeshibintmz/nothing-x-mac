// Commands the web view calls (see web/platform/nx.js).

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::{app_name, bridge::Bridge, platform, popover, tray, AUTHOR_URL, RELEASES_URL};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitInfo {
    app_name: String,
    /// This build's version, e.g. "0.2.0" (from package.json).
    app_version: String,
    /// "macos" or "windows"; the UI styles itself per platform.
    platform: &'static str,
    /// System accent colour as #rrggbb.
    accent: String,
    /// System symbols as image data URLs, used as CSS masks.
    symbols: BTreeMap<&'static str, Option<String>>,
}

#[tauri::command]
pub fn init(app: AppHandle) -> InitInfo {
    InitInfo {
        app_name: app_name(&app),
        app_version: app.package_info().version.to_string(),
        platform: platform::NAME,
        accent: platform::accent_color(),
        symbols: platform::symbols(),
    }
}

/// Keeps the window as tall as the panel's content.
#[tauri::command]
pub fn set_height(app: AppHandle, window: WebviewWindow, height: f64) {
    popover::set_height(&app, &window, height);
}

#[tauri::command]
pub fn set_tooltip(app: AppHandle, text: String) {
    tray::set_tooltip(&app, &text);
}

#[tauri::command]
pub fn open_author(app: AppHandle) {
    open_in_browser(&app, AUTHOR_URL);
}

/// "Check for updates": opens the latest release in the browser.
#[tauri::command]
pub fn open_releases(app: AppHandle) {
    open_in_browser(&app, RELEASES_URL);
}

fn open_in_browser(app: &AppHandle, url: &str) {
    if let Err(err) = app.opener().open_url(url, None::<&str>) {
        eprintln!("[shell] could not open {url}: {err}");
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
