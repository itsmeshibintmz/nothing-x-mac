import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../web/core/emitter.js';
import { NothingDevice } from '../web/core/nothing-device.js';
import { encodeFrame, FrameParser } from '../web/core/protocol.js';
import { Command, decodeProNoiseMode } from '../web/core/commands.js';

function fixture(t, name = 'Nothing Headphone (1) Pro') {
  const bridge = new Emitter();
  const writes = [];
  bridge.write = bytes => writes.push(new FrameParser().push(bytes)[0]);
  const device = new NothingDevice(bridge);
  const connect = (name, address = 'A') => bridge.emit('connected', { name, address });
  const disconnect = () => bridge.emit('disconnected');
  const report = (command, payload) => bridge.emit('data', encodeFrame(command, payload));
  connect(name);
  t.after(disconnect);
  return { device, connect, disconnect, report, writes, state: () => device.getState() };
}

test('headset and earbud battery reports, including zero and charging', t => {
  const f = fixture(t);
  f.report(0x4007, [1, 6, 0xc8]);
  assert.deepEqual(f.state().battery.stereo, {level: 72, charging: true});
  f.connect('CMF Buds 2 Plus', 'B');
  f.report(0xe001, [3, 2, 0, 3, 65, 4, 0x85]);
  assert.deepEqual(Object.values(f.state().battery).map(b => b?.level), [0, 65, 5, undefined]);
});

test('Flat EQ gates writes in core, ANC and EQ are confirmed from reports', t => {
  const f = fixture(t);
  f.report(0x401e, [1, 5, 0]);
  f.device.setNoiseMode('transparency');
  assert.equal(f.writes.length, 1); // initial battery read only
  f.report(0x4068, [0]);
  f.device.setNoiseMode('transparency');
  assert.equal(f.state().noiseMode, 'off');
  f.report(0x6003, [1, 254, 0]);
  assert.equal(f.state().noiseMode, 'transparency');
  assert.equal(f.state().noisePending, false);
  assert.deepEqual(decodeProNoiseMode([1, 2, 0, 2, 3, 0]), { mode: 'anc', strength: 'low' });
  f.report(0x404c, [0]);
  f.report(0x401f, [0]);
  f.device.setEqPreset(7);
  assert.equal(f.state().eq.preset, 0);
  f.report(0x401f, [7]);
  assert.equal(f.state().eq.preset, 7);
  f.report(0xe01c, [1]);
  const count = f.writes.length;
  f.device.setEqPreset(0);
  f.device.setCustomEq({ bass: 2 });
  f.device.setAdvancedEq(true);
  assert.equal(f.writes.length, count);
  f.report(0x601c, [0]);
  assert.equal(f.state().flatEq, false);
  assert.ok(f.writes.some(w => w.command === Command.GET_EQ));
});

test('reconnect cancels pending writes and old model startup reads', t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const f = fixture(t, 'CMF Buds 2 Plus');
  f.device.setCustomEq({bass:3});
  f.connect('Headphone (1) Pro');
  f.writes.length = 0;
  t.mock.timers.tick(2500);
  const commands = f.writes.map(w => w.command);
  assert.ok(commands.includes(Command.GET_FLAT_EQ));
  for (const cmd of [Command.SET_CUSTOM_EQ, Command.GET_BASS, Command.GET_SPATIAL_AUDIO]) assert.ok(!commands.includes(cmd));
});

test('switching from the Pro to Classic CMF earbuds restores battery and listening-mode controls', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t);
  f.report(0x4068, [1]);
  f.connect('CMF Buds 2 Plus', 'B');
  t.mock.timers.tick(3000);
  assert.equal(f.state().capabilities.pro, false);
  assert.ok(f.writes.some(w => w.command === Command.GET_LISTENING_MODE));
  assert.ok(!f.writes.some(w => w.command === Command.GET_FLAT_EQ || w.command === 0xc04d));
  f.report(0x4007, [3, 2, 75, 3, 70, 4, 80]);
  assert.equal(f.state().battery.left.level, 75);
  assert.equal(f.state().battery.right.level, 70);
  assert.equal(f.state().battery.case.level, 80);
  f.report(0x4050, [3]);
  f.device.setEqPreset(1);
  assert.ok(f.writes.some(w => w.command === Command.SET_LISTENING_MODE && w.payload[0] === 1));
  f.report(0x4050, [1]);
  assert.equal(f.state().eq.preset, 1);
  assert.equal(f.state().eq.pending, false);
});


test('a Fast Pair model ID identifies renamed Pro headphones', t => {
  const f = fixture(t);
  f.device.bridge.emit('connected', { name: 'Studio', address: 'A', modelId: 'B192' });
  assert.equal(f.state().capabilities.pro, true);
  assert.ok(f.state().capabilities.eq.presets.some(p => p.id === 7));
  f.connect('CMF Headphone Pro', 'B');
  assert.equal(f.state().capabilities.pro, false);
});

test('simple EQ waits for both the physical switch and the advanced mode readback', t => {
  const f = fixture(t);
  f.report(0x4068, [0]);
  f.report(0x404c, [1]);
  f.report(0x401f, [0]);
  f.writes.length = 0;
  f.device.setEqPreset(7);
  assert.equal(f.writes.length, 0);
  f.device.setAdvancedEq(false);
  assert.equal(f.writes[0].command, Command.SET_ADVANCED_EQ);
  assert.deepEqual([...f.writes[0].payload], [0, 0]);
  f.report(0x404c, [1]); // A stale reply must not unlock preset writes.
  f.device.setEqPreset(7);
  assert.equal(f.writes.length, 1);
  f.report(0x404c, [0]);
  f.device.setEqPreset(7);
  assert.equal(f.writes.at(-1).command, Command.SET_EQ);
  f.report(0x401f, [7]);
  assert.equal(f.state().eq.preset, 7);
  f.device.setAdvancedEq(true);
  assert.deepEqual([...f.writes.at(-1).payload], [1, 0]);
  f.report(0x404c, [1]);
  assert.equal(f.state().eq.advanced, true);
});

test('a Flat EQ notification cancels a queued custom EQ write', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t);
  f.report(0x4068, [0]);
  f.report(0x404c, [0]);
  f.device.setCustomEq({ bass: 2 });
  f.report(0x601c, [1]);
  t.mock.timers.tick(200);
  assert.ok(!f.writes.some(w => w.command === Command.SET_CUSTOM_EQ));
});
