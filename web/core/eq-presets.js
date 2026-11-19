// Equalizer preset lists per model family. Preset ids are what the earbuds
// send and expect; `key` picks the tile icon in the UI. Referenced from ear-web.
//
// Nothing models read/write presets with the "EQ" commands, CMF models with
// the "listening mode" commands. Custom always has the 3-band custom EQ.

const NOTHING = [
  { id: 0, key: 'balanced', label: 'Balanced' },
  { id: 3, key: 'moreBass', label: 'More Bass' },
  { id: 2, key: 'moreTreble', label: 'More Treble' },
  { id: 1, key: 'voice', label: 'Voice' },
];

const CMF = [
  { id: 3, key: 'pop', label: 'Pop' },
  { id: 1, key: 'rock', label: 'Rock' },
  { id: 5, key: 'classical', label: 'Classical' },
  { id: 2, key: 'electronic', label: 'Electronic' },
  { id: 4, key: 'vocals', label: 'Vocals' },
];

const dirac = (id) => ({ id, key: 'dirac', label: 'Dirac Opteo' });

// style: which command family; customId: preset id that turns on custom EQ (null = none)
const EQ_PROFILES = {
  nothing: { style: 'eq', presets: NOTHING, customId: 5 },
  nothingNoCustom: { style: 'eq', presets: NOTHING, customId: null },
  cmf: { style: 'listening', presets: [dirac(0), ...CMF], customId: 6 },
  cmfNoDirac: { style: 'listening', presets: CMF, customId: 6 },
  cmfDirac7: { style: 'listening', presets: [dirac(7), ...CMF], customId: 6 },
};

// -> { style, presets: [{ id, key, label }], customId, trebleHz }
function eqCapabilities(profileName, trebleHz) {
  const profile = EQ_PROFILES[profileName] ?? EQ_PROFILES.nothing;
  const presets = profile.customId === null
    ? profile.presets
    : [...profile.presets, { id: profile.customId, key: 'custom', label: 'Custom' }];
  return { style: profile.style, presets, customId: profile.customId, trebleHz };
}

export { eqCapabilities };
