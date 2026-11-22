// macOS: SF Symbols, the system accent colour and the login item.

use std::{collections::BTreeMap, sync::OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSColor, NSColorSpace, NSFontWeightRegular, NSImage,
    NSImageSymbolConfiguration, NSWindow, NSWindowCollectionBehavior,
};
use objc2_foundation::{NSDictionary, NSString};
use objc2_service_management::{SMAppService, SMAppServiceStatus};

pub const NAME: &str = "macos";
/// Label of the start-at-login item in the tray menu.
pub const LOGIN_ITEM_LABEL: &str = "Open at Login";

/// SF Symbols used by the panel, keyed by the names the UI uses (data-sym="…").
/// Loaded from macOS so they match the system exactly.
const SYMBOLS: &[(&str, &str)] = &[
    ("budLeft", "airpodpro.left"),
    ("budRight", "airpodpro.right"),
    ("case", "earbuds.case.fill"),
    ("anc", "person.wave.2.fill"),
    ("transparency", "ear.and.waveform"),
    ("off", "person.fill"),
    ("settings", "gearshape"),
    ("power", "power"),
    ("ancLow", "dial.low"),
    ("ancMid", "dial.medium"),
    ("ancHigh", "dial.high"),
    ("ancAdaptive", "sparkles"),
    ("bassToggle", "hifispeaker.fill"),
    ("bassWave", "waveform"),
    ("back", "chevron.left"),
    ("qsInEar", "ear"),
    ("qsLatency", "bolt.fill"),
    ("qsFind", "speaker.wave.2.fill"),
    ("qsSpatial", "person.spatialaudio.fill"),
    ("heart", "heart.fill"),
    ("qsPersonalSound", "waveform.and.person.filled"),
    ("qsDual", "macbook.and.iphone"),
    ("popUpChevrons", "chevron.up.chevron.down"),
    // Dual connection device rows (guessed from the device name)
    ("dev_laptop", "laptopcomputer"),
    ("dev_phone", "iphone"),
    ("dev_tablet", "ipad"),
    ("dev_desktop", "desktopcomputer"),
    ("dev_tv", "tv"),
    ("dev_watch", "applewatch"),
    ("dev_other", "antenna.radiowaves.left.and.right"),
    ("equalizer", "slider.vertical.3"),
    // Equalizer preset tiles (keys match web/core/eq-presets.js)
    ("eq_balanced", "equal.circle"),
    ("eq_moreBass", "speaker.wave.3.fill"),
    ("eq_moreTreble", "waveform.path.ecg"),
    ("eq_voice", "person.wave.2"),
    ("eq_dirac", "sparkles"),
    ("eq_pop", "music.note"),
    ("eq_rock", "guitars.fill"),
    ("eq_classical", "pianokeys"),
    ("eq_electronic", "waveform.path"),
    ("eq_vocals", "music.mic"),
    ("eq_custom", "slider.horizontal.3"),
];

/// Drawn large so the masks stay sharp on Retina displays; CSS scales them down.
const SYMBOL_POINT_SIZE: f64 = 48.0;

/// PNG data URLs the page uses as CSS masks, so glyphs pick up theme colours.
/// A symbol this macOS version doesn't have maps to null.
pub fn symbols() -> BTreeMap<&'static str, Option<String>> {
    static CACHE: OnceLock<BTreeMap<&'static str, Option<String>>> = OnceLock::new();
    CACHE
        .get_or_init(|| SYMBOLS.iter().map(|(key, name)| (*key, symbol_data_url(name))).collect())
        .clone()
}

#[allow(unused_unsafe)]
fn symbol_data_url(name: &str) -> Option<String> {
    let png = unsafe {
        let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str(name),
            None,
        )?;
        let config = NSImageSymbolConfiguration::configurationWithPointSize_weight(
            SYMBOL_POINT_SIZE,
            NSFontWeightRegular,
        );
        let image = image.imageWithSymbolConfiguration(&config)?;
        let tiff = image.TIFFRepresentation()?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())?
    };
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png.to_vec())))
}

/// The system accent colour as #rrggbb.
#[allow(unused_unsafe)]
pub fn accent_color() -> String {
    let rgb = unsafe {
        NSColor::controlAccentColor()
            .colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())
            .map(|c| (c.redComponent(), c.greenComponent(), c.blueComponent()))
    };
    let byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    match rgb {
        Some((r, g, b)) => format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b)),
        None => "#007aff".into(),
    }
}

/// The tray icon and whether it is a template image: the app logo, which
/// macOS tints for light and dark menu bars. Rebuilt by `npm run build:icon`.
pub fn tray_icon() -> (&'static [u8], bool) {
    (include_bytes!("../../icons/tray.png"), true)
}

/// Lets the window appear on every Space, including on top of another app's
/// full-screen Space (that needs its own flag, and an accessory app; see
/// main.rs). Call on the main thread.
#[allow(unused_unsafe)]
pub fn join_all_spaces(window: &tauri::WebviewWindow) {
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    unsafe {
        let ns_window: &NSWindow = &*ptr.cast();
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
}

/// Login items need an app bundle (…/Nothing X Mac.app/Contents/MacOS/…).
pub fn login_item_supported() -> bool {
    std::env::current_exe().is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
}

#[allow(unused_unsafe)]
pub fn login_item_enabled() -> bool {
    unsafe { SMAppService::mainAppService().status() == SMAppServiceStatus::Enabled }
}

#[allow(unused_unsafe)]
pub fn set_login_item_enabled(enabled: bool) -> Result<(), String> {
    let result = unsafe {
        let service = SMAppService::mainAppService();
        if enabled {
            service.registerAndReturnError()
        } else {
            service.unregisterAndReturnError()
        }
    };
    result.map_err(|err| err.localizedDescription().to_string())
}
