// Gesture layouts per model family: which gestures each bud has and the
// actions each gesture can be set to. Codes are what the earbuds use.
// Referenced from ear-web (CMF Buds 2 Plus / CMF Buds 2 / CMF Buds Pro 2 pages).

// "Noise Control" is one choice in the UI but several codes on the wire,
// depending on which modes tap and hold cycles through.
const NOISE_CONTROL = 'noise';

// [noise cancellation, transparency, off] -> code (at least two must be on)
const NOISE_CYCLE_CODES = [
  { code: 10, cycle: { anc: true, transparency: true, off: true } },
  { code: 20, cycle: { anc: false, transparency: true, off: true } },
  { code: 21, cycle: { anc: true, transparency: false, off: true } },
  { code: 22, cycle: { anc: true, transparency: true, off: false } },
];
const DEFAULT_NOISE_CODE = 22;

const isNoiseCode = (code) => NOISE_CYCLE_CODES.some((n) => n.code === code);
function noiseCodeForCycle(cycle) {
  return NOISE_CYCLE_CODES.find((n) => n.cycle.anc === Boolean(cycle.anc)
    && n.cycle.transparency === Boolean(cycle.transparency)
    && n.cycle.off === Boolean(cycle.off))?.code ?? null;
}

const PROFILES = {
  // Tap gestures on each bud (left = device 2, right = device 3).
  cmfTap: {
    sides: { left: 2, right: 3 },
    slots: [
      {
        key: 'doubleTap', label: 'Double Tap', type: 2,
        actions: [[2, 'Play/Pause'], [8, 'Skip Back'], [9, 'Skip Forward'], [11, 'Voice Assistant'], [1, 'Off']],
      },
      {
        key: 'tripleTap', label: 'Triple Tap', type: 3,
        actions: [[8, 'Skip Back'], [9, 'Skip Forward'], [11, 'Voice Assistant'], [1, 'Off']],
      },
      {
        key: 'tapHold', label: 'Tap and Hold', type: 7,
        actions: [[NOISE_CONTROL, 'Noise Control'], [11, 'Voice Assistant'], [1, 'Off']],
      },
      {
        key: 'doubleTapHold', label: 'Double Tap and Hold', type: 9,
        actions: [[18, 'Volume Up'], [19, 'Volume Down'], [11, 'Voice Assistant'], [1, 'Off']],
      },
    ],
  },
};

// -> { sides, slots: [{ key, label, type, actions: [{ value, label }] }], noiseCycles } or null
// noiseCycles maps each noise cycle code to { anc, transparency, off } for the UI.
function gestureCapabilities(profileName) {
  const profile = PROFILES[profileName];
  if (!profile) return null;
  return {
    sides: profile.sides,
    noiseCycles: Object.fromEntries(NOISE_CYCLE_CODES.map(({ code, cycle }) => [code, cycle])),
    slots: profile.slots.map((s) => ({
      key: s.key,
      label: s.label,
      type: s.type,
      actions: s.actions.map(([value, label]) => ({ value, label })),
    })),
  };
}

export {
  NOISE_CONTROL,
  DEFAULT_NOISE_CODE,
  isNoiseCode,
  noiseCodeForCycle,
  gestureCapabilities,
};
