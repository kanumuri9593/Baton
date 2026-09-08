import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeviceRegistry } from '../src/daemon/devices.ts';

/** A registry populated from the transcript captured off a real `flutter daemon`. */
function fromRealTranscript(): DeviceRegistry {
  const registry = new DeviceRegistry('/tmp');
  registry.ingest(readFileSync('test/fixtures/daemon-devices.txt', 'utf8'));
  return registry;
}

test('builds the device list from real device.added events', () => {
  const devices = fromRealTranscript().list();
  assert.equal(devices.length, 5);
  const iphone = devices.find((d) => d.name === 'iPhone 17 Pro')!;
  assert.equal(iphone.id, '48F0A0D1-0CEC-4781-B73B-BE0F494DD23D');
  assert.equal(iphone.emulator, true);
  assert.equal(iphone.capabilities!.screenshot, true);
});

test('resolves configs to devices the way a human picks from the dropdown', () => {
  const registry = fromRealTranscript();

  assert.equal(registry.resolveForName('iOS Simulator (DEV / dev flavor)')!.platformType, 'ios');
  assert.equal(registry.resolveForName('Android (TST / qa flavor)')!.id, 'emulator-5556');
  assert.match(registry.resolveForName('iPad regression run')!.name, /iPad/);
  assert.equal(registry.resolveForName('macOS desktop build')!.id, 'macos');
});

test('a platform-neutral Flutter target prefers a running mobile simulator over macOS and Chrome', () => {
  const registry = fromRealTranscript();
  const chosen = registry.resolveForName('Dev / Retail (local GCP)')!;
  assert.ok(chosen.platformType === 'ios' || chosen.platformType === 'android');
  assert.equal(chosen.emulator, true);
});

test('an explicit device id always wins over the name heuristic', () => {
  const registry = fromRealTranscript();
  const chosen = registry.resolveForName('iOS Simulator (DEV)', '15AE8779-8EA5-4CEF-A1A7-2472C4FCC20E');
  assert.equal(chosen!.name, 'iPhone 17');
});

test('an unknown explicit id falls back to the heuristic rather than failing', () => {
  const registry = fromRealTranscript();
  assert.equal(registry.resolveForName('iOS Simulator (DEV)', 'NOT-CONNECTED')!.platformType, 'ios');
});

test('device.removed drops the device again', () => {
  const registry = fromRealTranscript();
  registry.ingest('[{"event":"device.removed","params":{"id":"macos"}}]\n');
  assert.ok(!registry.list().some((d) => d.id === 'macos'));
});

test('returns undefined when nothing is connected', () => {
  assert.equal(new DeviceRegistry('/tmp').resolveForName('iOS Simulator (DEV)'), undefined);
});

test('never crosses platforms: an iOS config with no iOS device resolves to nothing', () => {
  const registry = new DeviceRegistry('/tmp');
  // only a desktop device is present -- the exact situation that silently built
  // an iOS config for macOS and looked like an eight-minute hang
  registry.ingest('[{"event":"device.added","params":{"id":"macos","name":"macOS","platform":"darwin","platformType":"macos","emulator":false,"category":"desktop"}}]\n');
  assert.equal(registry.resolveForName('iOS Simulator (DEV / dev flavor)'), undefined);
  assert.equal(registry.resolveForName('Android (TST / qa flavor)'), undefined);
});

test('a physical-device config does not resolve to a simulator', () => {
  const registry = fromRealTranscript();
  // the transcript contains only simulators and desktop, no physical iPhone
  assert.equal(registry.resolveForName('iOS Physical Device (TST / qa — QR testing)'), undefined);
});

test('the word "device" alone does not imply a physical device', () => {
  const registry = fromRealTranscript();
  // "iOS Simulator" configs must still match simulators even though many config
  // names contain the word device elsewhere
  assert.equal(registry.resolveForName('iOS Simulator (DEV / dev flavor)')!.emulator, true);
});

test('describes what was wanted so the error message is actionable', () => {
  assert.match(DeviceRegistry.describePreference('iOS Simulator (DEV)'), /ios/i);
  assert.match(DeviceRegistry.describePreference('Android (TST)'), /android/i);
});
