// Nothing X Mac: the app shell.
//
// A menu bar (tray) icon with a popover window. The earbud logic and the UI
// both live in the web view (../web); this shell provides what a web page
// can't: the tray, the window, native menus, system symbols, Open at Login
// and the Bluetooth transport.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;
mod login_item;
mod platform;
mod popover;
mod popup_menu;
mod tray;

use tauri::{AppHandle, Manager, RunEvent};

pub const AUTHOR_URL: &str = "https://yashraut.me";

/// The product name for this platform (from the Tauri config).
pub fn app_name(app: &AppHandle) -> String {
    app.package_info().name.clone()
}

fn main() {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(popover::PopoverState::default())
        .invoke_handler(tauri::generate_handler![
            commands::init,
            commands::set_height,
            commands::set_tooltip,
            commands::open_author,
            commands::quit,
            commands::bridge_connection,
            commands::bridge_write,
            popup_menu::popup_menu,
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if !popup_menu::handle_menu_event(app, id) {
                tray::handle_menu_event(app, id);
            }
        })
        .on_window_event(popover::on_window_event)
        .setup(|app| {
            let handle = app.handle().clone();

            login_item::enable_on_first_run(&handle);
            app.manage(bridge::Bridge::start(&handle));
            tray::create(&handle)?;

            // Dev convenience: NXM_OPEN=1 npm start opens the popover on launch.
            if std::env::var_os("NXM_OPEN").is_some() {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    let app = handle.clone();
                    let _ = handle.run_on_main_thread(move || popover::show(&app, None));
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Nothing X Mac");

    // Menu bar only: no Dock icon. This has to happen before the event loop
    // starts (not in `setup`, which runs after launch): macOS only lets a
    // window appear over another app's full-screen Space if the app was
    // already an accessory app when the window was created.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    app.run(|app, event| {
        // Close the Bluetooth channel cleanly; otherwise the earbuds keep it
        // open and refuse the next connection.
        if let RunEvent::Exit = event {
            app.state::<bridge::Bridge>().stop();
        }
    });
}
