// Gesture controls: what each tap gesture does on the left and right bud.
//
// Owns the `gestures` slice of device state:
//   { left: { doubleTap: code, … }, right: { … }, pending: { 'left.doubleTap': true, … } }
// Codes are the earbuds' action codes (see gesture-profiles.js); a slot set to
// Noise Control holds one of the noise cycle codes (10/20/21/22).

import {
  Command, Response, decodeGestures, encodeGesture,
} from './commands.js';
import {
  NOISE_CONTROL, DEFAULT_NOISE_CODE, isNoiseCode, noiseCodeForCycle,
} from './gesture-profiles.js';

// After a change, read all gestures back to confirm; clear the spinner if no
// answer comes.
const READ_BACK_MS = 400;
const PENDING_TIMEOUT_MS = 4_000;

function initialGestureState() {
  return { left: {}, right: {}, pending: {} };
}

class Gestures {
  // send(command, payload), patch(partial), capabilities() -> caps, state() -> gestures slice
  constructor({ send, patch, capabilities, state }) {
    this.send = send;
    this.patch = patch;
    this.capabilities = capabilities;
    this.state = state;
    this.readTimer = null;
    this.pendingTimer = null;
  }

  onConnected(startDelayMs = 0) {
    if (this.capabilities().gestures) setTimeout(() => this.send(Command.GET_GESTURES), startDelayMs);
  }

  // Returns true if the frame belonged to gestures.
  handle(frame) {
    if (!Response.GESTURES.includes(frame.command)) return false;
    const caps = this.capabilities().gestures;
    if (!caps) return true;

    const next = { left: { ...this.state().left }, right: { ...this.state().right } };
    for (const record of decodeGestures(frame.payload)) {
      const side = Object.keys(caps.sides).find((s) => caps.sides[s] === record.device);
      const slot = caps.slots.find((s) => s.type === record.type);
      if (side && slot) next[side][slot.key] = record.action;
    }
    clearTimeout(this.pendingTimer);
    this.patch({ ...next, pending: {} });
    return true;
  }

  // value: an action code, or NOISE_CONTROL to use the slot's current (or the
  // default) noise cycle.
  setAction(side, slotKey, value) {
    const caps = this.capabilities().gestures;
    const slot = caps?.slots.find((s) => s.key === slotKey);
    if (!slot || !caps.sides[side]) return;
    if (!slot.actions.some((a) => a.value === value)) return;

    const current = this.state()[side][slotKey];
    let code = value;
    if (value === NOISE_CONTROL) {
      if (isNoiseCode(current)) return; // already Noise Control
      code = DEFAULT_NOISE_CODE;
    }
    if (code === current) return;
    this.#write(side, slot, code);
  }

  // cycle: { anc, transparency, off } — at least two on. Only for a slot that's
  // set to Noise Control.
  setNoiseCycle(side, slotKey, cycle) {
    const caps = this.capabilities().gestures;
    const slot = caps?.slots.find((s) => s.key === slotKey);
    if (!slot || !isNoiseCode(this.state()[side]?.[slotKey])) return;
    const code = noiseCodeForCycle(cycle);
    if (code === null || code === this.state()[side][slotKey]) return;
    this.#write(side, slot, code);
  }

  reset() {
    clearTimeout(this.readTimer);
    clearTimeout(this.pendingTimer);
  }

  #write(side, slot, code) {
    const caps = this.capabilities().gestures;
    this.send(Command.SET_GESTURE, encodeGesture(caps.sides[side], slot.type, code));

    const key = `${side}.${slot.key}`;
    this.patch({
      [side]: { ...this.state()[side], [slot.key]: code },
      pending: { ...this.state().pending, [key]: true },
    });

    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => this.send(Command.GET_GESTURES), READ_BACK_MS);
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.patch({ pending: {} }), PENDING_TIMEOUT_MS);
  }
}

export { Gestures, initialGestureState };
