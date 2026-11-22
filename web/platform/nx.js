// `nx`: everything the UI needs from outside the page.
//
// The earbud logic (web/core) runs here in the web view; the app shell
// (src-tauri) provides the window, tray, native menus, system symbols and the
// Bluetooth transport.

import { NothingDevice } from '../core/nothing-device.js';
import { BluetoothBridge } from './bluetooth-bridge.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The product name on this platform; the shell reports it in `init`.
let appName = 'Nothing X';
// How long to wait for a menu choice after the menu reports it closed.
const MENU_CHOICE_GRACE_MS = 150;

const device = new NothingDevice(new BluetoothBridge({ invoke, listen }));
const accentListeners = [];

// ---- tray tooltip -----------------------------------------------------------

let tooltip = null;
device.on('change', (state) => {
  const next = state.connected ? `${appName} · ${state.name}` : appName;
  if (next === tooltip) return;
  tooltip = next;
  invoke('set_tooltip', { text: next });
});

// ---- native pop-up menu -----------------------------------------------------

// The open menu: { items, resolve }, or null.
let openMenu = null;

function settleMenu(value) {
  if (!openMenu) return;
  const { resolve } = openMenu;
  openMenu = null;
  resolve(value);
}

// items: [{ label, value, checked }]; x/y: where to open it, in page coordinates.
// Resolves with the chosen value, or null if the menu was dismissed.
function popupMenu(items, x, y) {
  settleMenu(null);
  return new Promise((resolve) => {
    openMenu = { items, resolve };
    invoke('popup_menu', {
      items: items.map((item) => ({ label: item.label, checked: Boolean(item.checked) })),
      x,
      y,
    }).catch(() => settleMenu(null));
  });
}

// ---- start-up ---------------------------------------------------------------

async function init() {
  await listen('menu:chosen', (event) => settleMenu(openMenu?.items[event.payload]?.value ?? null));
  // The choice arrives just after the menu closes; no choice means dismissed.
  await listen('menu:closed', () => {
    const menu = openMenu;
    setTimeout(() => { if (openMenu === menu) settleMenu(null); }, MENU_CHOICE_GRACE_MS);
  });
  await listen('popover:shown', (event) => {
    device.refreshPanel();
    for (const cb of accentListeners) cb(event.payload.accent);
  });

  const info = await invoke('init');
  appName = info.appName;
  await device.start();
  return { ...info, device: device.getState() };
}

const nx = {
  init,
  setHeight: (height) => invoke('set_height', { height }),
  onAccent: (cb) => accentListeners.push(cb),
  quit: () => invoke('quit'),
  openAuthor: () => invoke('open_author'),
  // "Check for updates": opens the latest release on GitHub in the browser.
  openReleases: () => invoke('open_releases'),
  popupMenu,

  onDeviceState: (cb) => device.on('change', cb),
  setNoiseMode: (mode) => device.setNoiseMode(mode),
  setAncStrength: (strength) => device.setAncStrength(strength),
  setBass: (change) => device.setBass(change),
  setQuickToggle: (name, on) => device.setQuickToggle(name, on),
  ring: (side, on) => device.ring(side, on),
  setSpatialAudio: (mode) => device.setSpatialAudio(mode),
  setDualConnection: (on) => device.setDualConnection(on),
  setDualDevice: (mac, connect) => device.setDualDeviceConnected(mac, connect),
  setGesture: (side, slot, value) => device.setGesture(side, slot, value),
  setGestureNoiseCycle: (side, slot, cycle) => device.setGestureNoiseCycle(side, slot, cycle),
  setEqPreset: (id) => device.setEqPreset(id),
  setAdvancedEq: (on) => device.setAdvancedEq(on),
  setCustomEq: (bands) => device.setCustomEq(bands),
};

export { nx };
