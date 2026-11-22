// Equalizer: preset selection (confirmed by the earbuds) and the 3-band
// custom EQ (Bass / Mid / Treble, −6..+6 dB).
//
// Owns the `eq` slice of device state. The device passes in how to send
// commands and publish state, and forwards incoming frames.

import {
  Command, Response, decodePreset, encodePreset, decodeCustomEq, encodeCustomEq,
} from './commands.js';
import { ConfirmedSetting } from './confirmed-setting.js';

const GAIN_LIMIT = 6;
// Slider drags can fire quickly; only the last value within this window is sent.
const CUSTOM_SEND_DELAY_MS = 120;
const LOCAL_CUSTOM_WINS_MS = 1_000;

function initialEqState() {
  return {
    preset: null, // preset id once read
    pending: false, // a preset change is waiting for confirmation
    advanced: null, // Pro: the headphones are using their saved Advanced EQ
    advancedPending: false,
    custom: null, // { bass, mid, treble } in dB once read
  };
}

const clampGain = (v) => Math.max(-GAIN_LIMIT, Math.min(GAIN_LIMIT, Math.round(Number(v) || 0)));

class Equalizer {
  // send(command, payload), patch(partialEqState), capabilities() -> caps, state() -> eq slice
  constructor({ send, patch, capabilities, state }) {
    this.send = send;
    this.patch = patch;
    this.capabilities = capabilities;
    this.state = state;
    this.customTimer = null;
    this.customReadTimer = null;
    this.lastLocalCustomAt = 0;

    this.confirm = new ConfirmedSetting({
      read: () => this.send(this.#commands().get),
      matches: (report, target) => report === target,
      onTimeout: () => this.patch({ pending: false }),
    });
    this.advancedConfirm = new ConfirmedSetting({
      read: () => this.send(Command.GET_ADVANCED_EQ),
      matches: (reported, target) => reported === target,
      onTimeout: () => this.patch({ advanced: null, advancedPending: false }),
    });
  }

  onConnected(startDelayMs = 0, later = setTimeout) {
    const eq = this.capabilities().eq;
    later(() => this.send(this.#commands().get), startDelayMs);
    if (eq.customId !== null) later(() => this.send(Command.GET_CUSTOM_EQ), startDelayMs + 150);
  }

  // Returns true if the frame belonged to the equalizer.
  handle(frame) {
    if (this.capabilities().pro && Response.ADVANCED_EQ.includes(frame.command)) {
      const value = frame.payload[0];
      if ((value === 0 || value === 1) && this.advancedConfirm.accept(value === 1)) {
        if (value === 1) clearTimeout(this.customTimer);
        this.patch({ advanced: value === 1, advancedPending: false });
      }
      return true;
    }
    if (Response.EQ_PRESET.includes(frame.command)) {
      const preset = decodePreset(frame.payload);
      if (this.confirm.accept(preset)) this.patch({ preset, pending: false });
      return true;
    }
    if (Response.CUSTOM_EQ.includes(frame.command)) {
      // Don't let a read that crossed a slider change undo the user's values.
      if (Date.now() - this.lastLocalCustomAt > LOCAL_CUSTOM_WINS_MS) {
        this.patch({ custom: decodeCustomEq(frame.payload) });
      }
      return true;
    }
    return false;
  }

  setPreset(id) {
    const eq = this.capabilities().eq;
    if (this.confirm.pending || id === this.state().preset) return;
    if (!eq.presets.some((p) => p.id === id)) return;

    this.send(this.#commands().set, encodePreset(id));
    this.confirm.begin(id);
    this.patch(this.capabilities().pro ? { pending: true } : { preset: id, pending: true });
    // Picking Custom: load the saved bands so the sliders show them.
    if (id === eq.customId) this.customReadTimer = setTimeout(() => this.send(Command.GET_CUSTOM_EQ), 300);
  }

  setAdvanced(on) {
    const state = this.state();
    if (!this.capabilities().pro || typeof on !== 'boolean' || state.advanced === null ||
        on === state.advanced || this.advancedConfirm.pending || this.confirm.pending) return;
    clearTimeout(this.customTimer);
    this.send(Command.SET_ADVANCED_EQ, [Number(on), 0]);
    this.advancedConfirm.begin(on);
    this.patch({ advancedPending: true });
  }

  // bands: any of { bass, mid, treble } in dB. Applies immediately in the UI,
  // sends the full set to the earbuds (debounced).
  setCustom(bands) {
    const eq = this.capabilities().eq;
    if (eq.customId === null) return;
    const current = this.state().custom ?? { bass: 0, mid: 0, treble: 0 };
    const next = {
      bass: clampGain(bands.bass ?? current.bass),
      mid: clampGain(bands.mid ?? current.mid),
      treble: clampGain(bands.treble ?? current.treble),
    };
    this.patch({ custom: next });
    this.lastLocalCustomAt = Date.now();

    clearTimeout(this.customTimer);
    this.customTimer = setTimeout(() => {
      this.send(Command.SET_CUSTOM_EQ, encodeCustomEq(next, eq.trebleHz));
    }, CUSTOM_SEND_DELAY_MS);
  }

  reset() {
    this.confirm.reset();
    this.advancedConfirm.reset();
    clearTimeout(this.customTimer);
    clearTimeout(this.customReadTimer);
    this.lastLocalCustomAt = 0;
  }

  #commands() {
    return this.capabilities().eq.style === 'listening'
      ? { get: Command.GET_LISTENING_MODE, set: Command.SET_LISTENING_MODE }
      : { get: Command.GET_EQ, set: Command.SET_EQ };
  }
}

export { Equalizer, initialEqState };
