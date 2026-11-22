// Placeholder for platforms without native support (Linux).

use std::collections::BTreeMap;

pub const NAME: &str = "other";
pub const LOGIN_ITEM_LABEL: &str = "Open at Login";

pub fn accent_color() -> String {
    "#0078d4".into()
}

pub fn symbols() -> BTreeMap<&'static str, Option<String>> {
    BTreeMap::new()
}

pub fn tray_icon() -> (&'static [u8], bool) {
    (include_bytes!("../../icons/tray.png"), false)
}

pub fn join_all_spaces(_window: &tauri::WebviewWindow) {}

pub fn login_item_supported() -> bool {
    false
}

pub fn login_item_enabled() -> bool {
    false
}

pub fn set_login_item_enabled(_enabled: bool) -> Result<(), String> {
    Err("not supported on this platform yet".into())
}
