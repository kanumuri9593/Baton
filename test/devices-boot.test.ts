import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listSimulators, mergeBootables, runtimeLabel } from '../src/daemon/simulators.ts';
import { DeviceRegistry } from '../src/daemon/devices.ts';

/** A stand-in for `xcrun`, replaying what this machine really answered. */
const simctl = () => readFileSync('test/fixtures/simctl-devices.json', 'utf8');

const darwinOnly = { skip: process.platform !== 'darwin' ? 'simctl is macOS-only' : false };

test('runtime identifiers become something a human can read', () => {
  assert.equal(runtimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-26-5'), 'iOS 26.5');
  assert.equal(runtimeLabel('com.apple.CoreSimulator.SimRuntime.watchOS-11-0'), 'watchOS 11.0');
  assert.equal(runtimeLabel('nonsense'), undefined);
});

test('lists every simulator model, not just the booted ones', darwinOnly, () => {
  const simulators = listSimulators(simctl);
  const names = simulators.map((s) => s.name);

  // The whole point: an IDE offers "start a simulator"; this offers the model.
  assert.ok(names.includes('iPhone 17 Pro'), 'a booted device is still listed');
  assert.ok(names.includes('iPad mini (A17 Pro)'), 'a shutdown device is listed too');
  assert.ok(simulators.every((s) => s.via === 'simctl' && s.platformType === 'ios'));
  assert.ok(simulators.every((s) => s.runtime?.startsWith('iOS')));
});

test('booted simulators are marked running so they are not offered as bootable', darwinOnly, () => {
  const simulators = listSimulators(simctl);
  const booted = simulators.filter((s) => s.running);
  assert.ok(booted.length > 0, 'this fixture was recorded with simulators booted');
  assert.ok(
    simulators.some((s) => !s.running),
    'and with others shut down, or the distinction is untested',
  );
});

test('a machine without Xcode gets an empty list rather than a crash', () => {
  const missing = () => { throw new Error('xcrun: command not found'); };
  assert.deepEqual(listSimulators(missing), []);
});

/**
 * The registry merges two sources. Replaying a recorded daemon transcript
 * exercises the merge without needing a simulator or an Android SDK present.
 */
function replayed(): DeviceRegistry {
  const registry = new DeviceRegistry('/nonexistent');
  registry.ingest(readFileSync('test/fixtures/daemon-devices.txt'));
  return registry;
}

test('an AVD that is already running is not offered as something to start', async () => {
  const registry = replayed();
  // The recorded transcript has Pixel_10_Pro_NoPlayStore up as emulator-5556.
  const running = registry.list().find((d) => d.id === 'emulator-5556');
  assert.equal(running?.emulatorId, 'Pixel_10_Pro_NoPlayStore');

  const bootables = await registry.bootables();
  const offered = bootables.find((b) => b.id === 'Pixel_10_Pro_NoPlayStore');
  // Either absent (no Android tooling here) or present and marked running --
  // what must never happen is offering to boot it a second time.
  assert.ok(!offered || offered.running, 'a running AVD must not look startable');
  registry.dispose();
});

test('booting an id nothing knows about fails by name', async () => {
  const registry = replayed();
  await assert.rejects(
    () => registry.boot('not-a-real-device'),
    /no bootable device with id "not-a-real-device"/,
  );
  registry.dispose();
});

// --- merging the two sources ---------------------------------------------

/** The real `emulator.getEmulators` reply, recorded from a Flutter daemon. */
function recordedEmulators(): any[] {
  const line = readFileSync('test/fixtures/daemon-emulators.txt', 'utf8')
    .split('\n')
    .find((l) => l.includes('"result"'))!;
  return JSON.parse(line)[0].result;
}

const nothingRunning = { deviceIds: new Set<string>(), emulatorIds: new Set<string>() };

test('Flutter\'s generic "iOS Simulator" entry gives way to the real models', () => {
  const simulators = listSimulators(simctl);
  const merged = mergeBootables(simulators, recordedEmulators(), nothingRunning);

  assert.ok(
    !merged.some((b) => b.id === 'apple_ios_simulator'),
    'one "start a simulator" entry beside twelve named models would be a worse menu',
  );
  assert.ok(merged.some((b) => b.name === 'iPhone 17 Pro Max' && b.via === 'simctl'));
  assert.ok(merged.some((b) => b.id === 'Pixel_10_Pro' && b.via === 'flutter'));
});

test('without simctl, the generic iOS entry is kept — it is all there is', () => {
  const merged = mergeBootables([], recordedEmulators(), nothingRunning);
  assert.ok(
    merged.some((b) => b.id === 'apple_ios_simulator'),
    'dropping it on a machine with no Xcode would offer nothing for iOS at all',
  );
});

test('a running AVD and a booted simulator are both marked, not hidden', () => {
  const simulators = listSimulators(simctl);
  const anySimulator = simulators[0];
  const merged = mergeBootables(simulators, recordedEmulators(), {
    deviceIds: new Set([anySimulator?.id ?? '']),
    emulatorIds: new Set(['Pixel_10_Pro']),
  });

  assert.equal(merged.find((b) => b.id === anySimulator?.id)?.running, true);
  assert.equal(merged.find((b) => b.id === 'Pixel_10_Pro')?.running, true);
  assert.equal(merged.find((b) => b.id === 'Pixel_10_Pro_NoPlayStore')?.running, false);
});
