// What differs per operating system: the panel's icons, the accent colour,
// the tray icon and the start-at-login switch.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(not(any(target_os = "macos", windows)))]
mod fallback;
#[cfg(not(any(target_os = "macos", windows)))]
pub use fallback::*;
