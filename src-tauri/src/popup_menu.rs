// Native pop-up menu for the panel's pop-up buttons.
//
// The page calls `popup_menu` with the items and where to open the menu, then
// hears back through two events: "menu:chosen" (the index of the item picked)
// and "menu:closed" (the menu went away, with or without a choice).

use std::sync::atomic::Ordering;

use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, Menu},
    AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow,
};

use crate::popover::{self, PopoverState};

const ID_PREFIX: &str = "popup:";

#[derive(Deserialize)]
pub struct PopupItem {
    label: String,
    checked: bool,
}

/// x/y are in page coordinates.
#[tauri::command]
pub async fn popup_menu(
    app: AppHandle,
    window: WebviewWindow,
    items: Vec<PopupItem>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let handle = app.clone();
    // The menu runs its own event loop until it closes, so open it from the
    // main loop rather than from inside this command.
    app.run_on_main_thread(move || {
        if let Err(err) = show(&handle, &window, &items, x, y) {
            eprintln!("[shell] pop-up menu failed: {err}");
        }
        let _ = handle.emit_to(popover::LABEL, "menu:closed", ());
    })
    .map_err(|err| err.to_string())
}

fn show(
    app: &AppHandle,
    window: &WebviewWindow,
    items: &[PopupItem],
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    for (index, item) in items.iter().enumerate() {
        let id = format!("{ID_PREFIX}{index}");
        menu.append(&CheckMenuItem::with_id(app, id, &item.label, true, item.checked, None::<&str>)?)?;
    }

    let open = &app.state::<PopoverState>().popup_menu_open;
    open.store(true, Ordering::SeqCst);
    let result = window.popup_menu_at(&menu, LogicalPosition::new(x.round(), y.round()));
    open.store(false, Ordering::SeqCst);
    result
}

/// Returns true if `id` belongs to a pop-up menu item.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    let Some(index) = id.strip_prefix(ID_PREFIX).and_then(|i| i.parse::<usize>().ok()) else {
        return false;
    };
    let _ = app.emit_to(popover::LABEL, "menu:chosen", index);
    true
}
