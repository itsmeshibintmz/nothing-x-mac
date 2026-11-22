// Quick settings: in-ear detection, low latency mode, Personal Sound Profile,
// spatial audio, find my earbuds and firmware version.
//
// Owns the `quick` slice of device state. The device passes in how to send
// commands and how to publish state changes, and forwards incoming frames.

import {
  Command, Response,
  decodeInEar, encodeInEar, decodeLowLatency, encodeLowLatency,
  decodeFirmware, encodeRing, decodeSpatialAudio, encodeSpatialAudio,
  decodePersonalSound, encodePersonalSound,
} from './commands.js';
import { ConfirmedSetting } from './confirmed-setting.js';

const READ_GAP_MS = 150;
const RING_AUTO_STOP_MS = 30_000;

// On/off settings: how to read, write and decode each one for this model.
// Each returns null when the model doesn't have the setting.
const TOGGLES = {
  inEar: (caps) => (caps.inEar ? {
    get: Command.GET_IN_EAR, set: Command.SET_IN_EAR, responses: Response.IN_EAR,
    decode: decodeInEar, encode: encodeInEar,
  } : null),
  lowLatency: (caps) => (caps.lowLatency ? {
    get: Command.GET_LOW_LATENCY, set: Command.SET_LOW_LATENCY, responses: Response.LOW_LATENCY,
    decode: decodeLowLatency, encode: encodeLowLatency,
  } : null),
  personalSound: (caps) => {
    if (caps.personalSound === 'mimi') {
      return {
        get: Command.GET_MIMI, set: Command.SET_MIMI, responses: Response.MIMI,
        decode: decodePersonalSound, encode: encodePersonalSound,
      };
    }
    if (caps.personalSound === 'audiodo') {
      return {
        get: Command.GET_AUDIODO, set: Command.SET_AUDIODO, responses: Response.AUDIODO,
        decode: decodePersonalSound, encode: encodePersonalSound,
      };
    }
    return null;
  },
};
const TOGGLE_NAMES = Object.keys(TOGGLES);

function initialQuickState() {
  return {
    inEar: null, // true/false once read; null if unknown or unsupported
    lowLatency: null,
    personalSound: null,
    spatial: null, // spatial audio mode key ('off', 'fixed', …) once read
    pending: { inEar: false, lowLatency: false, personalSound: false, spatial: false },
    firmware: null,
    ringing: null, // 'left' | 'right' | 'all' while a find sound is playing
  };
}

class QuickSettings {
  // send(command, payload), patch(partialQuickState), capabilities() -> caps
  constructor({ send, patch, capabilities }) {
    this.send = send;
    this.patch = patch;
    this.capabilities = capabilities;
    this.ringTimer = null;
    this.ringSide = null;
    this.pendingFlags = { inEar: false, lowLatency: false, personalSound: false, spatial: false };

    this.confirm = {};
    for (const name of TOGGLE_NAMES) {
      this.confirm[name] = new ConfirmedSetting({
        read: () => {
          const spec = this.#spec(name);
          if (spec) this.send(spec.get);
        },
        matches: (report, target) => report === target,
        onTimeout: () => this.#setPending(name, false),
      });
    }
    this.confirm.spatial = new ConfirmedSetting({
      read: () => this.send(Command.GET_SPATIAL_AUDIO),
      matches: (report, target) => report === target,
      onTimeout: () => this.#setPending('spatial', false),
    });
  }

  // Read everything this model supports, staggered so the buds aren't flooded.
  onConnected(startDelayMs = 0, later = setTimeout) {
    const caps = this.capabilities();
    const reads = [Command.GET_FIRMWARE];
    for (const name of TOGGLE_NAMES) {
      const spec = this.#spec(name);
      if (spec) reads.push(spec.get);
    }
    if (caps.spatialModes.length) reads.push(Command.GET_SPATIAL_AUDIO);
    reads.forEach((command, i) => later(() => this.send(command), startDelayMs + i * READ_GAP_MS));
  }

  // Returns true if the frame belonged to quick settings.
  handle(frame) {
    for (const name of TOGGLE_NAMES) {
      const spec = this.#spec(name);
      if (spec?.responses.includes(frame.command)) {
        const value = spec.decode(frame.payload);
        if (this.confirm[name].accept(value)) {
          this.pendingFlags[name] = false;
          this.patch({ [name]: value, pending: { ...this.pendingFlags } });
        }
        return true;
      }
    }
    if (Response.SPATIAL_AUDIO.includes(frame.command)) {
      const mode = decodeSpatialAudio(frame.payload);
      if (this.confirm.spatial.accept(mode)) {
        this.pendingFlags.spatial = false;
        this.patch({ spatial: mode, pending: { ...this.pendingFlags } });
      }
      return true;
    }
    if (Response.FIRMWARE.includes(frame.command)) {
      this.patch({ firmware: decodeFirmware(frame.payload) || null });
      return true;
    }
    return false;
  }

  // name: 'inEar' | 'lowLatency' | 'personalSound'. Ignored while that setting
  // is still switching or the model doesn't have it.
  setToggle(name, on, current) {
    const spec = this.#spec(name);
    if (!spec || this.confirm[name].pending || current === on) return;
    this.send(spec.set, spec.encode(on));
    this.confirm[name].begin(on);
    this.pendingFlags[name] = true;
    this.patch({ [name]: on, pending: { ...this.pendingFlags } });
  }

  // mode: a key from capabilities.spatialModes. Ignored while a change is in flight.
  setSpatial(mode, current) {
    const modes = this.capabilities().spatialModes;
    if (!modes.some((m) => m.key === mode) || this.confirm.spatial.pending || current === mode) return;
    this.send(Command.SET_SPATIAL_AUDIO, encodeSpatialAudio(mode));
    this.confirm.spatial.begin(mode);
    this.pendingFlags.spatial = true;
    this.patch({ spatial: mode, pending: { ...this.pendingFlags } });
  }

  // side: 'left' | 'right' for buds; ignored for headphone/single styles.
  // Only one sound at a time; it stops by itself after 30 seconds.
  ring(side, on) {
    const style = this.capabilities().ring;
    const target = style === 'buds' ? side : 'all';
    if (on && this.ringSide && this.ringSide !== target) this.#stopRing();
    if (!on) return this.#stopRing();

    this.send(Command.RING, encodeRing(style, target, true));
    this.ringSide = target;
    clearTimeout(this.ringTimer);
    this.ringTimer = setTimeout(() => this.#stopRing(), RING_AUTO_STOP_MS);
    this.patch({ ringing: target });
  }

  reset() {
    for (const c of Object.values(this.confirm)) c.reset();
    clearTimeout(this.ringTimer);
    this.ringSide = null;
    this.pendingFlags = { inEar: false, lowLatency: false, personalSound: false, spatial: false };
  }

  #stopRing() {
    if (!this.ringSide) return;
    this.send(Command.RING, encodeRing(this.capabilities().ring, this.ringSide, false));
    this.ringSide = null;
    clearTimeout(this.ringTimer);
    this.patch({ ringing: null });
  }

  #spec(name) {
    return TOGGLES[name]?.(this.capabilities()) ?? null;
  }

  #setPending(name, value) {
    this.pendingFlags[name] = value;
    this.patch({ pending: { ...this.pendingFlags } });
  }
}

export { QuickSettings, initialQuickState };
