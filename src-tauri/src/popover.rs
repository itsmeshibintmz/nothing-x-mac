// The popover: a borderless window anchored to the tray icon that hides when
// it loses focus. It drops down from the macOS menu bar and opens upward from
// the Windows taskbar.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewWindow,
    Window, WindowEvent,
};

use crate::{platform, tray};

pub const LABEL: &str = "popover";
const WIDTH: f64 = 300.0;
/// Height before the page reports its real one (matches the window config).
const INITIAL_HEIGHT: f64 = 360.0;
const MIN_HEIGHT: f64 = 100.0;
const MAX_HEIGHT: f64 = 800.0;
/// Gap between the tray icon's bar and the popover, and to the screen edges (points).
const TRAY_GAP: f64 = 4.0;
const SCREEN_MARGIN: f64 = 8.0;
/// A click on the tray icon blurs (and hides) the popover first; a click this
/// soon after hiding is that same click and must not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

pub struct PopoverState {
    last_hidden: Mutex<Option<Instant>>,
    /// True while a native pop-up menu from the panel is open: it takes focus,
    /// but shouldn't close the panel.
    pub popup_menu_open: AtomicBool,
    /// Current window height in points.
    height: Mutex<f64>,
    /// The tray icon's rectangle the popover was last placed against.
    anchor: Mutex<Option<Rect>>,
    /// True when the popover sits above the icon (a taskbar at the bottom).
    /// Its bottom edge must then stay put when the height changes.
    opens_upward: AtomicBool,
}

impl Default for PopoverState {
    fn default() -> Self {
        Self {
            last_hidden: Mutex::new(None),
            popup_menu_open: AtomicBool::new(false),
            height: Mutex::new(INITIAL_HEIGHT),
            anchor: Mutex::new(None),
            opens_upward: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Serialize)]
struct Shown {
    accent: String,
}

fn popover_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Shows the popover next to the tray icon. `anchor` is the icon's rectangle;
/// when missing it is looked up.
pub fn show(app: &AppHandle, anchor: Option<Rect>) {
    let Some(window) = popover_window(app) else { return };
    if let Some(rect) = anchor.or_else(|| tray::rect(app)) {
        position(app, &window, &rect);
    }
    // Follow the user into whichever Space they are in, full-screen included.
    platform::join_all_spaces(&window);
    let _ = window.show();
    let _ = window.set_focus();
    // The page refreshes the battery and picks up a changed accent colour.
    let _ = app.emit_to(LABEL, "popover:shown", Shown { accent: platform::accent_color() });
}

pub fn hide(app: &AppHandle) {
    let Some(window) = popover_window(app) else { return };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = window.hide();
    *app.state::<PopoverState>().last_hidden.lock().unwrap() = Some(Instant::now());
}

pub fn toggle(app: &AppHandle, anchor: Rect) {
    let Some(window) = popover_window(app) else { return };
    if window.is_visible().unwrap_or(false) {
        return hide(app);
    }
    let just_hidden = app
        .state::<PopoverState>()
        .last_hidden
        .lock()
        .unwrap()
        .is_some_and(|at| at.elapsed() < REOPEN_GUARD);
    if !just_hidden {
        show(app, Some(anchor));
    }
}

pub fn set_height(app: &AppHandle, window: &WebviewWindow, height: f64) {
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT).ceil();
    let state = app.state::<PopoverState>();
    *state.height.lock().unwrap() = height;
    let _ = window.set_size(LogicalSize::new(WIDTH, height));

    // Growing downward would push an upward-opening popover into the taskbar.
    if state.opens_upward.load(Ordering::SeqCst) {
        let anchor = *state.anchor.lock().unwrap();
        if let Some(anchor) = anchor {
            position(app, window, &anchor);
        }
    }
}

/// Centres the popover on the tray icon, kept inside the icon's screen: below
/// an icon in the top half of the screen, above one in the bottom half.
fn position(app: &AppHandle, window: &WebviewWindow, anchor: &Rect) {
    let state = app.state::<PopoverState>();
    *state.anchor.lock().unwrap() = Some(*anchor);

    let origin: PhysicalPosition<f64> = anchor.position.to_physical(1.0);
    let monitor = app
        .monitor_from_point(origin.x, origin.y)
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let scale = monitor.as_ref().map_or(1.0, |m| m.scale_factor());

    let icon_pos: PhysicalPosition<f64> = anchor.position.to_physical(scale);
    let icon_size: PhysicalSize<f64> = anchor.size.to_physical(scale);
    let width = WIDTH * scale;

    let mut x = icon_pos.x + icon_size.width / 2.0 - width / 2.0;
    if let Some(monitor) = &monitor {
        let left = f64::from(monitor.position().x) + SCREEN_MARGIN * scale;
        let right = f64::from(monitor.position().x) + f64::from(monitor.size().width)
            - width
            - SCREEN_MARGIN * scale;
        x = x.clamp(left, right.max(left));
    }
    let icon_centre_y = icon_pos.y + icon_size.height / 2.0;
    let screen_centre_y = monitor.as_ref().map_or(f64::MAX, |m| {
        f64::from(m.position().y) + f64::from(m.size().height) / 2.0
    });
    let opens_upward = icon_centre_y > screen_centre_y;
    state.opens_upward.store(opens_upward, Ordering::SeqCst);

    let y = if opens_upward {
        let height = *state.height.lock().unwrap() * scale;
        icon_pos.y - height - TRAY_GAP * scale
    } else {
        icon_pos.y + icon_size.height + TRAY_GAP * scale
    };

    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != LABEL {
        return;
    }
    if let WindowEvent::Focused(false) = event {
        let app = window.app_handle();
        if app.state::<PopoverState>().popup_menu_open.load(Ordering::SeqCst) {
            return;
        }
        // Keep the panel up while it is being inspected.
        #[cfg(debug_assertions)]
        if popover_window(app).is_some_and(|w| w.is_devtools_open()) {
            return;
        }
        hide(app);
    }
}
