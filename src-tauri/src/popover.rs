// The popover: a borderless, translucent window that drops down from the tray
// icon and hides when it loses focus.

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
const MIN_HEIGHT: f64 = 100.0;
const MAX_HEIGHT: f64 = 800.0;
/// Gap between the menu bar and the popover, and to the screen edges (points).
const TRAY_GAP: f64 = 4.0;
const SCREEN_MARGIN: f64 = 8.0;
/// A click on the tray icon blurs (and hides) the popover first; a click this
/// soon after hiding is that same click and must not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct PopoverState {
    last_hidden: Mutex<Option<Instant>>,
    /// True while a native pop-up menu from the panel is open: it takes focus,
    /// but shouldn't close the panel.
    pub popup_menu_open: AtomicBool,
}

#[derive(Clone, Serialize)]
struct Shown {
    accent: String,
}

fn popover_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Shows the popover under the tray icon. `anchor` is the icon's rectangle;
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

pub fn set_height(window: &WebviewWindow, height: f64) {
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT).ceil();
    let _ = window.set_size(LogicalSize::new(WIDTH, height));
}

/// Centres the popover under the tray icon, kept inside the icon's screen.
fn position(app: &AppHandle, window: &WebviewWindow, anchor: &Rect) {
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
    let y = icon_pos.y + icon_size.height + TRAY_GAP * scale;

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
