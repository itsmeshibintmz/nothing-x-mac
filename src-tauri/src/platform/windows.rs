// Windows: Fluent icons, the system accent colour, the taskbar theme and the
// "start with Windows" entry.

use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD, Engine};
use windows_registry::CURRENT_USER;

pub const NAME: &str = "windows";
/// Label of the start-at-login item in the tray menu.
pub const LOGIN_ITEM_LABEL: &str = "Start with Windows";

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "NothingXMac";
const DWM_KEY: &str = r"Software\Microsoft\Windows\DWM";
const THEME_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
/// Windows' default accent blue, used if the user's colour can't be read.
const DEFAULT_ACCENT: &str = "#0078d4";

macro_rules! fluent {
    ($name:literal) => {
        include_str!(concat!("../../icons/fluent/", $name, ".svg"))
    };
}

/// Icons for the panel, keyed by the names the UI uses (data-sym="…").
/// Windows has no SF Symbols, so these are Microsoft's Fluent System Icons
/// (MIT licence, see icons/fluent/LICENSE), which match Windows 11.
const SYMBOLS: &[(&str, &str)] = &[
    ("budLeft", fluent!("surface_earbuds_20_filled")),
    ("budRight", fluent!("surface_earbuds_20_filled")),
    ("case", fluent!("box_20_filled")),
    ("anc", fluent!("headphones_sound_wave_20_filled")),
    ("transparency", fluent!("sound_source_20_regular")),
    ("off", fluent!("person_20_filled")),
    ("settings", fluent!("settings_20_regular")),
    ("power", fluent!("power_20_regular")),
    ("ancLow", fluent!("speaker_0_20_regular")),
    ("ancMid", fluent!("speaker_1_20_regular")),
    ("ancHigh", fluent!("speaker_2_20_regular")),
    ("ancAdaptive", fluent!("sparkle_20_regular")),
    ("bassToggle", fluent!("speaker_box_20_filled")),
    ("bassWave", fluent!("data_bar_vertical_20_regular")),
    ("back", fluent!("chevron_left_20_regular")),
    ("qsInEar", fluent!("surface_earbuds_20_regular")),
    ("qsLatency", fluent!("flash_20_filled")),
    ("qsFind", fluent!("speaker_2_20_filled")),
    ("qsSpatial", fluent!("person_sound_spatial_20_filled")),
    ("heart", fluent!("heart_20_filled")),
    ("qsPersonalSound", fluent!("person_voice_20_regular")),
    ("qsDual", fluent!("phone_laptop_20_filled")),
    ("popUpChevrons", fluent!("chevron_up_down_20_regular")),
    // Dual connection device rows (guessed from the device name)
    ("dev_laptop", fluent!("laptop_20_regular")),
    ("dev_phone", fluent!("phone_20_regular")),
    ("dev_tablet", fluent!("tablet_20_regular")),
    ("dev_desktop", fluent!("desktop_20_regular")),
    ("dev_tv", fluent!("tv_20_regular")),
    ("dev_watch", fluent!("smartwatch_20_regular")),
    ("dev_other", fluent!("bluetooth_20_regular")),
    ("equalizer", fluent!("device_eq_20_regular")),
    // Equalizer preset tiles (keys match web/core/eq-presets.js)
    ("eq_balanced", fluent!("equal_circle_20_regular")),
    ("eq_moreBass", fluent!("speaker_box_20_regular")),
    ("eq_moreTreble", fluent!("pulse_20_regular")),
    ("eq_voice", fluent!("person_voice_20_regular")),
    ("eq_dirac", fluent!("sparkle_20_regular")),
    ("eq_pop", fluent!("music_note_2_20_regular")),
    ("eq_rock", fluent!("guitar_20_regular")),
    ("eq_classical", fluent!("midi_20_regular")),
    ("eq_electronic", fluent!("sine_wave_dots_20_regular")),
    ("eq_vocals", fluent!("mic_20_regular")),
    ("eq_custom", fluent!("options_20_regular")),
];

/// SVG data URLs the page uses as CSS masks, so glyphs pick up theme colours.
pub fn symbols() -> BTreeMap<&'static str, Option<String>> {
    SYMBOLS
        .iter()
        .map(|(key, svg)| {
            (*key, Some(format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg))))
        })
        .collect()
}

/// The user's accent colour as #rrggbb.
pub fn accent_color() -> String {
    // Stored as 0xAABBGGRR.
    match CURRENT_USER.open(DWM_KEY).and_then(|key| key.get_u32("AccentColor")) {
        Ok(abgr) => {
            format!("#{:02x}{:02x}{:02x}", abgr & 0xff, (abgr >> 8) & 0xff, (abgr >> 16) & 0xff)
        }
        Err(_) => DEFAULT_ACCENT.into(),
    }
}

/// The tray icon and whether it is a template image (macOS only).
/// Windows doesn't tint tray icons, so pick the one that contrasts with the
/// taskbar: dark logo on a light taskbar, white logo on a dark one.
pub fn tray_icon() -> (&'static [u8], bool) {
    let light_taskbar = CURRENT_USER
        .open(THEME_KEY)
        .and_then(|key| key.get_u32("SystemUsesLightTheme"))
        .is_ok_and(|value| value != 0);
    if light_taskbar {
        (include_bytes!("../../icons/tray-windows-dark.png"), false)
    } else {
        (include_bytes!("../../icons/tray-windows-light.png"), false)
    }
}

/// Spaces are a macOS concept.
pub fn join_all_spaces(_window: &tauri::WebviewWindow) {}

pub fn login_item_supported() -> bool {
    true
}

/// True if Windows is set to start this copy of the app at sign-in.
pub fn login_item_enabled() -> bool {
    let Some(command) = run_command() else { return false };
    CURRENT_USER
        .open(RUN_KEY)
        .and_then(|key| key.get_string(RUN_VALUE))
        .is_ok_and(|value| value.eq_ignore_ascii_case(&command))
}

pub fn set_login_item_enabled(enabled: bool) -> Result<(), String> {
    let key = CURRENT_USER.create(RUN_KEY).map_err(|err| err.to_string())?;
    if enabled {
        let command = run_command().ok_or("could not find the app's own path")?;
        key.set_string(RUN_VALUE, command).map_err(|err| err.to_string())
    } else {
        match key.remove_value(RUN_VALUE) {
            // Already absent is fine.
            Ok(()) | Err(_) => Ok(()),
        }
    }
}

/// The quoted path Windows runs at sign-in.
fn run_command() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(format!("\"{}\"", exe.display()))
}
