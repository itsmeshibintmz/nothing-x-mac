// High-level earbud state: connection, name, battery, noise control, bass,
// equalizer, quick settings, dual connection and gestures. Emits 'change' with a plain snapshot whenever anything updates.
//
// Platform-neutral: it talks to the earbuds through a `bridge`, a byte
// transport supplied by the platform (see web/platform/bluetooth-bridge.js):
//   bridge.start() / bridge.stop() / bridge.write(Uint8Array)
//   bridge events: 'connected' ({ name, address }), 'data' (Uint8Array), 'disconnected'

import { Emitter } from './emitter.js';
import { encodeFrame, FrameParser } from './protocol.js';
import {
  Command, Response, decodeBattery, decodeNoiseMode, encodeNoiseMode, decodeBass, encodeBass,
} from './commands.js';
import { capabilitiesForName, bassLevels } from './models.js';
import { ConfirmedSetting } from './confirmed-setting.js';
import { QuickSettings, initialQuickState } from './quick-settings.js';
import { Equalizer, initialEqState } from './equalizer.js';
import { DualConnection, initialDualState } from './dual-connection.js';
import { Gestures, initialGestureState } from './gestures.js';

const BATTERY_POLL_MS = 60_000;
const INITIAL_QUERY_GAP_MS = 150;

function emptyState() {
  return {
    connected: false,
    name: null,
    battery: { left: null, right: null, case: null, stereo: null },
    noiseMode: null, // 'anc' | 'transparency' | 'off'
    ancStrength: null, // 'low' | 'mid' | 'high' | 'adaptive' (while noiseMode is 'anc')
    noisePending: false, // a noise switch was sent and isn't confirmed yet
    bass: null, // { enabled, level } once read; null if unknown or unsupported
    bassPending: false,
    quick: initialQuickState(),
    eq: initialEqState(),
    dual: initialDualState(),
    gestures: initialGestureState(),
    capabilities: {
      transparency: true, strengths: [], adaptive: false, bassSteps: 0, bassLevels: [],
      inEar: false, lowLatency: false, ring: 'buds', spatialModes: [],
      dualConnection: false, dualRestarts: false, personalSound: null, gestures: null,
      eq: { style: 'eq', presets: [], customId: null, trebleHz: 3400 },
    },
  };
}

class NothingDevice extends Emitter {
  constructor(bridge) {
    super();
    this.bridge = bridge;
    this.parser = new FrameParser();
    this.state = emptyState();
    this.operationId = 0;
    this.batteryTimer = null;
    // Strength to use when noise cancellation is turned back on.
    this.lastAncStrength = 'high';

    this.noise = new ConfirmedSetting({
      read: () => this.#send(Command.GET_NOISE_MODE),
      matches: (r, t) => r.mode === t.mode && (r.mode !== 'anc' || r.strength === t.strength),
      onTimeout: () => this.#update({ noisePending: false }),
    });
    this.bassSetting = new ConfirmedSetting({
      read: () => this.#send(Command.GET_BASS),
      matches: (r, t) => r.enabled === t.enabled && (!t.enabled || r.level === t.level),
      onTimeout: () => this.#update({ bassPending: false }),
    });
    this.quick = new QuickSettings({
      send: (command, payload) => this.#send(command, payload),
      patch: (partial) => this.#update({ quick: { ...this.state.quick, ...partial } }),
      capabilities: () => this.state.capabilities,
    });
    this.equalizer = new Equalizer({
      send: (command, payload) => this.#send(command, payload),
      patch: (partial) => this.#update({ eq: { ...this.state.eq, ...partial } }),
      capabilities: () => this.state.capabilities,
      state: () => this.state.eq,
    });
    this.dual = new DualConnection({
      send: (command, payload) => this.#send(command, payload),
      patch: (partial) => this.#update({ dual: { ...this.state.dual, ...partial } }),
      capabilities: () => this.state.capabilities,
      state: () => this.state.dual,
    });
    this.gestures = new Gestures({
      send: (command, payload) => this.#send(command, payload),
      patch: (partial) => this.#update({ gestures: { ...this.state.gestures, ...partial } }),
      capabilities: () => this.state.capabilities,
      state: () => this.state.gestures,
    });

    bridge.on('connected', (info) => this.#onConnected(info));
    bridge.on('disconnected', () => this.#onDisconnected());
    bridge.on('data', (chunk) => this.#onData(chunk));
  }

  start() {
    return this.bridge.start();
  }

  stop() {
    this.#clearTimers();
    this.bridge.stop();
  }

  getState() {
    return structuredClone(this.state);
  }

  // Setters ignore requests while a previous change of the same kind is still
  // in flight, so rapid clicks can't queue up commands on the earbuds.

  setNoiseMode(mode) {
    if (!this.state.connected || this.noise.pending || mode === this.state.noiseMode) return;
    const strength = mode === 'anc' ? this.#usableStrength(this.lastAncStrength) : null;
    this.#applyNoise(mode, strength);
  }

  // 'low' | 'mid' | 'high' | 'adaptive'
  setAncStrength(strength) {
    if (!this.state.connected || this.noise.pending) return;
    if (this.state.noiseMode === 'anc' && strength === this.state.ancStrength) return;
    this.#applyNoise('anc', this.#usableStrength(strength));
  }

  // { enabled?: boolean, level?: number } — missing fields keep their current value.
  setBass(change) {
    const { bass, capabilities } = this.state;
    if (!this.state.connected || this.bassSetting.pending || !capabilities.bassSteps) return;

    const levels = capabilities.bassLevels;
    const enabled = change.enabled ?? bass?.enabled ?? false;
    let level = change.level ?? bass?.level ?? levels[0];
    if (!levels.includes(level)) level = levels[0];
    if (bass && bass.enabled === enabled && (!enabled || bass.level === level)) return;

    this.#send(Command.SET_BASS, encodeBass(enabled, level, capabilities.bassSteps));
    this.bassSetting.begin({ enabled, level });
    this.#update({ bass: { enabled, level }, bassPending: true });
  }

  refreshBattery() {
    this.#send(Command.GET_BATTERY);
  }

  // ---- equalizer (see equalizer.js) ----------------------------------------

  setEqPreset(id) {
    if (this.state.connected) this.equalizer.setPreset(id);
  }

  // bands: any of { bass, mid, treble } in dB
  setCustomEq(bands) {
    if (this.state.connected) this.equalizer.setCustom(bands);
  }

  // ---- dual connection (see dual-connection.js) -----------------------------

  setDualConnection(on) {
    if (this.state.connected) this.dual.setEnabled(on);
  }

  setDualDeviceConnected(mac, connect) {
    if (this.state.connected) this.dual.setDeviceConnected(mac, connect);
  }

  // ---- gestures (see gestures.js) -------------------------------------------

  // side: 'left' | 'right'; value: action code or 'noise'
  setGesture(side, slotKey, value) {
    if (this.state.connected) this.gestures.setAction(side, slotKey, value);
  }

  // cycle: { anc, transparency, off }
  setGestureNoiseCycle(side, slotKey, cycle) {
    if (this.state.connected) this.gestures.setNoiseCycle(side, slotKey, cycle);
  }

  // ---- quick settings (see quick-settings.js) -------------------------------

  // name: 'inEar' | 'lowLatency'
  setQuickToggle(name, on) {
    if (!this.state.connected) return;
    this.quick.setToggle(name, on, this.state.quick[name]);
  }

  // mode: 'off' | 'fixed' | 'headTracked' | … (see capabilities.spatialModes)
  setSpatialAudio(mode) {
    if (this.state.connected) this.quick.setSpatial(mode, this.state.quick.spatial);
  }

  // side: 'left' | 'right' (ignored on headphones)
  ring(side, on) {
    if (this.state.connected) this.quick.ring(side, on);
  }

  // ---- noise ----------------------------------------------------------------

  #usableStrength(strength) {
    const { strengths, adaptive } = this.state.capabilities;
    if (strength === 'adaptive' && adaptive) return 'adaptive';
    if (strengths.includes(strength)) return strength;
    return 'high';
  }

  #applyNoise(mode, strength) {
    this.#send(Command.SET_NOISE_MODE, encodeNoiseMode(mode, strength ?? undefined));
    this.noise.begin({ mode, strength });
    this.#setNoiseState(mode, strength);
  }

  #onNoiseReport(report) {
    if (this.noise.accept(report)) this.#setNoiseState(report.mode, report.strength);
  }

  #setNoiseState(mode, strength) {
    if (mode === 'anc' && strength) this.lastAncStrength = strength;
    this.#update({
      noiseMode: mode,
      ancStrength: mode === 'anc' ? strength : null,
      noisePending: this.noise.pending,
    });
  }

  // ---- bass -----------------------------------------------------------------

  #onBassReport(payload) {
    let caps = this.state.capabilities;
    // A wire level of 5 only exists on 3-step models: correct a name-based guess.
    if (caps.bassSteps === 5 && payload[1] === 5) {
      caps = { ...caps, bassSteps: 3, bassLevels: bassLevels(3) };
      this.#update({ capabilities: caps });
    }

    const report = decodeBass(payload, caps.bassSteps);
    if (!this.bassSetting.accept(report)) return;

    // Disabled models remember their last level; keep showing it.
    const level = report.level ?? this.state.bass?.level ?? caps.bassLevels[0];
    this.#update({ bass: { enabled: report.enabled, level }, bassPending: false });
  }

  // ---- plumbing -------------------------------------------------------------

  #send(command, payload = []) {
    this.operationId = (this.operationId + 1) & 0xff;
    this.bridge.write(encodeFrame(command, payload, this.operationId));
  }

  #update(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.getState());
  }

  #onConnected({ name }) {
    this.parser.reset();
    const base = capabilitiesForName(name);
    const capabilities = { ...base, bassLevels: bassLevels(base.bassSteps) };
    this.#update({ connected: true, name, capabilities });

    // Stagger the first reads so the earbuds aren't flooded.
    this.refreshBattery();
    setTimeout(() => this.#send(Command.GET_NOISE_MODE), INITIAL_QUERY_GAP_MS);
    if (capabilities.bassSteps) {
      setTimeout(() => this.#send(Command.GET_BASS), INITIAL_QUERY_GAP_MS * 2);
    }
    this.quick.onConnected(INITIAL_QUERY_GAP_MS * 3);
    this.equalizer.onConnected(INITIAL_QUERY_GAP_MS * 7);
    this.dual.onConnected(INITIAL_QUERY_GAP_MS * 9);
    this.gestures.onConnected(INITIAL_QUERY_GAP_MS * 11);

    clearInterval(this.batteryTimer);
    this.batteryTimer = setInterval(() => this.refreshBattery(), BATTERY_POLL_MS);
  }

  #onDisconnected() {
    this.#clearTimers();
    this.parser.reset();
    if (this.state.connected) {
      this.state = emptyState();
      this.emit('change', this.getState());
    }
  }

  #onData(chunk) {
    for (const frame of this.parser.push(chunk)) {
      if (Response.BATTERY.includes(frame.command)) {
        this.#update({ battery: decodeBattery(frame.payload) });
      } else if (Response.NOISE_MODE.includes(frame.command)) {
        const report = decodeNoiseMode(frame.payload);
        if (report) this.#onNoiseReport(report);
      } else if (Response.BASS.includes(frame.command)) {
        if (this.state.capabilities.bassSteps) this.#onBassReport(frame.payload);
      } else if (!this.equalizer.handle(frame) && !this.dual.handle(frame) && !this.gestures.handle(frame)) {
        this.quick.handle(frame);
      }
    }
  }

  #clearTimers() {
    this.noise.reset();
    this.bassSetting.reset();
    this.quick.reset();
    this.equalizer.reset();
    this.dual.reset();
    this.gestures.reset();
    clearInterval(this.batteryTimer);
    this.batteryTimer = null;
  }
}

export { NothingDevice };
