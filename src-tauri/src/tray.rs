// Menu bar icon: left click toggles the popover, right click opens a menu.

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Rect, Wry,
};
use tauri_plugin_opener::OpenerExt;

use crate::{login_item, popover, APP_NAME, AUTHOR_URL};

const TRAY_ID: &str = "main";
const OPEN_AT_LOGIN: &str = "open-at-login";
const AUTHOR: &str = "author";
const QUIT: &str = "quit";

/// The app logo as a template image; rebuilt by `npm run build:icon`.
const ICON: &[u8] = include_bytes!("../icons/tray.png");

struct TrayMenu {
    open_at_login: CheckMenuItem<Wry>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open_at_login = CheckMenuItem::with_id(
        app,
        OPEN_AT_LOGIN,
        "Open at Login",
        // Only the installed app can start at login.
        login_item::is_supported(),
        login_item::is_enabled(),
        None::<&str>,
    )?;
    let author = MenuItem::with_id(app, AUTHOR, "Made by Yash Raut · yashraut.me", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, format!("Quit {APP_NAME}"), true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_at_login,
            &PredefinedMenuItem::separator(app)?,
            &author,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.manage(TrayMenu { open_at_login });

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON)?)
        // macOS tints it for light and dark menu bars.
        .icon_as_template(true)
        .tooltip(APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    rect,
                    ..
                } => popover::toggle(app, rect),
                TrayIconEvent::Click { button: MouseButton::Right, .. } => popover::hide(app),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

pub fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        OPEN_AT_LOGIN => {
            let item = &app.state::<TrayMenu>().open_at_login;
            login_item::set_enabled(item.is_checked().unwrap_or(false));
            // Show what the system actually ended up with.
            let _ = item.set_checked(login_item::is_enabled());
        }
        AUTHOR => {
            if let Err(err) = app.opener().open_url(AUTHOR_URL, None::<&str>) {
                eprintln!("[shell] could not open {AUTHOR_URL}: {err}");
            }
        }
        QUIT => app.exit(0),
        _ => {}
    }
}

pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}

/// Where the icon sits on screen.
pub fn rect(app: &AppHandle) -> Option<Rect> {
    app.tray_by_id(TRAY_ID)?.rect().ok().flatten()
}
