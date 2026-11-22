// Dual connection: the on/off switch, the earbuds' remembered devices, and
// connecting or disconnecting each one (at most 2 connected at once).
//
// Owns the `dual` slice of device state. The device passes in how to send
// commands and publish state, and forwards incoming frames.

import {
  Command, Response,
  decodeDualEnable, encodeDualEnable, decodeDualList, encodeDualListRequest,
  decodeDualDeviceEvent, encodeDualConnect,
} from './commands.js';
import { ConfirmedSetting } from './confirmed-setting.js';

const MAX_CONNECTED = 2;
const MAX_LIST_PAGES = 20;
// Connecting a phone can take a while; give up on the spinner after this.
const CONNECT_TIMEOUT_MS = 15_000;

function initialDualState() {
  return {
    enabled: null, // true/false once read
    pending: false, // the on/off switch is waiting for confirmation
    devices: [], // [{ mac, name, isSelf, isConnected }]
    busyMac: null, // device currently being connected/disconnected
    maxConnected: MAX_CONNECTED,
  };
}

class DualConnection {
  // send(command, payload), patch(partialDualState), capabilities() -> caps, state() -> dual slice
  constructor({ send, patch, capabilities, state }) {
    this.send = send;
    this.patch = patch;
    this.capabilities = capabilities;
    this.state = state;
    this.pagesRequested = 0;
    this.busyTimer = null;

    this.confirm = new ConfirmedSetting({
      read: () => this.send(Command.GET_DUAL_ENABLE),
      matches: (report, target) => report === target,
      onTimeout: () => this.patch({ pending: false }),
    });
  }

  onConnected(startDelayMs = 0, later = setTimeout) {
    if (!this.capabilities().dualConnection) return;
    later(() => this.send(Command.GET_DUAL_ENABLE), startDelayMs);
    later(() => this.refreshList(), startDelayMs + 150);
  }

  refreshList() {
    this.pagesRequested = 0;
    this.patch({ devices: [] });
    this.#requestPage(0);
  }

  // Returns true if the frame belonged to dual connection.
  handle(frame) {
    if (Response.DUAL_ENABLE.includes(frame.command)) {
      const enabled = decodeDualEnable(frame.payload);
      if (this.confirm.accept(enabled)) {
        const turnedOn = enabled && this.state().enabled === false;
        this.patch({ enabled, pending: false });
        if (turnedOn) this.refreshList();
      }
      return true;
    }
    if (Response.DUAL_LIST.includes(frame.command)) {
      this.#mergePage(decodeDualList(frame.payload));
      return true;
    }
    if (Response.DUAL_DEVICE_EVENT.includes(frame.command)) {
      this.#onDeviceEvent(decodeDualDeviceEvent(frame.payload));
      return true;
    }
    return false;
  }

  setEnabled(on) {
    const { enabled } = this.state();
    if (!this.capabilities().dualConnection || this.confirm.pending || enabled === on) return;
    this.send(Command.SET_DUAL_ENABLE, encodeDualEnable(on));
    this.confirm.begin(on);
    this.patch({ enabled: on, pending: true });
  }

  // Connect or disconnect a remembered device. One at a time; this Mac can't
  // be disconnected from here (that would drop the app's own connection).
  setDeviceConnected(mac, connect) {
    const { enabled, devices, busyMac } = this.state();
    const device = devices.find((d) => d.mac === mac);
    if (!enabled || busyMac || !device || device.isSelf || device.isConnected === connect) return;
    if (connect && devices.filter((d) => d.isConnected).length >= MAX_CONNECTED) return;

    this.send(Command.SET_DUAL_CONNECT, encodeDualConnect(mac, connect));
    clearTimeout(this.busyTimer);
    this.busyTimer = setTimeout(() => {
      this.patch({ busyMac: null });
      this.refreshList(); // show whatever actually happened
    }, CONNECT_TIMEOUT_MS);
    this.patch({ busyMac: mac });
  }

  reset() {
    this.confirm.reset();
    clearTimeout(this.busyTimer);
    this.pagesRequested = 0;
  }

  #requestPage(start) {
    this.pagesRequested++;
    this.send(Command.GET_DUAL_LIST, encodeDualListRequest(start));
  }

  // Pages may repeat devices; keep requesting while new ones keep arriving.
  #mergePage(page) {
    const devices = [...this.state().devices];
    let added = false;
    for (const device of page) {
      const i = devices.findIndex((d) => d.mac === device.mac);
      if (i >= 0) devices[i] = device;
      else {
        devices.push(device);
        added = true;
      }
    }
    this.patch({ devices: sortDevices(devices) });
    if (added && page.length && this.pagesRequested < MAX_LIST_PAGES) this.#requestPage(devices.length);
  }

  #onDeviceEvent({ mac, isConnected }) {
    const { devices, busyMac } = this.state();
    if (!devices.some((d) => d.mac === mac)) {
      this.refreshList(); // a device we haven't seen yet
      return;
    }
    const patch = {
      devices: sortDevices(devices.map((d) => (d.mac === mac ? { ...d, isConnected } : d))),
    };
    if (busyMac === mac) {
      clearTimeout(this.busyTimer);
      patch.busyMac = null;
    }
    this.patch(patch);
  }
}

// This Mac first, then connected devices, then the rest by name.
function sortDevices(devices) {
  return devices.sort((a, b) => (b.isSelf - a.isSelf)
    || (b.isConnected - a.isConnected)
    || a.name.localeCompare(b.name));
}

export { DualConnection, initialDualState };
