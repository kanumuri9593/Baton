import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Keep the daemon's state out of the real ~/.baton.
process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-capture-'));

const { screenshotSession } = await import('../src/daemon/capture.ts');
const { DeviceRegistry } = await import('../src/daemon/devices.ts');
import type { ExecFn } from '../src/daemon/capture.ts';
import type { SessionSnapshot } from '../src/core/types.ts';

const IOS_UDID = '48F0A0D1-0CEC-4781-B73B-BE0F494DD23D';
const ANDROID_SERIAL = 'emulator-5554';

function snapshot(target?: string): SessionSnapshot {
  return {
    id: 'proj/flutter-app',
    name: 'flutter-app',
    kind: 'flutter',
    status: 'running',
    target,
    capabilities: ['screenshot'],
    startedAt: Date.now(),
  };
}

/** Records every call, and answers with whatever the test set up. */
function fakeExec(answer: Partial<Record<string, { code: number; stdout: string | Buffer; stderr: string }>> = {}) {
  const calls: Array<{ cmd: string; args: string[]; opts?: { encoding?: 'utf8' | 'buffer' } }> = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answer[cmd] ?? { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

test('an iOS simulator target runs xcrun simctl io <udid> screenshot <path>', async () => {
  const outPath = join(mkdtempSync(join(tmpdir(), 'baton-cap-')), 'shot.png');
  const { exec, calls } = fakeExec({ xcrun: { code: 0, stdout: '', stderr: '' } });

  const result = await screenshotSession(snapshot(IOS_UDID), outPath, exec);

  assert.equal(result.path, outPath);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'xcrun');
  assert.deepEqual(calls[0].args, ['simctl', 'io', IOS_UDID, 'screenshot', outPath]);
});

test('an Android target runs adb exec-out screencap and writes the binary stdout to the file', async () => {
  const outPath = join(mkdtempSync(join(tmpdir(), 'baton-cap-')), 'shot.png');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const { exec, calls } = fakeExec({ adb: { code: 0, stdout: png, stderr: '' } });

  const result = await screenshotSession(snapshot(ANDROID_SERIAL), outPath, exec);

  assert.equal(result.path, outPath);
  assert.equal(calls[0].cmd, 'adb');
  assert.deepEqual(calls[0].args, ['-s', ANDROID_SERIAL, 'exec-out', 'screencap', '-p']);
  assert.equal(calls[0].opts?.encoding, 'buffer', 'exec-out is binary; the ExecFn must be asked for a buffer');
  assert.deepEqual(readFileSync(outPath), png, 'the exact bytes adb produced must land on disk unmodified');
});

test('an unknown or missing target throws, without shelling out to anything', async () => {
  const { exec, calls } = fakeExec();

  await assert.rejects(
    screenshotSession(snapshot('some-desktop-window'), join(tmpdir(), 'x.png'), exec),
    /iOS simulator or Android device/,
  );
  await assert.rejects(
    screenshotSession(snapshot(undefined), join(tmpdir(), 'x.png'), exec),
    /iOS simulator or Android device/,
  );
  assert.equal(calls.length, 0, 'an unsupported target must not run any external tool');
});

test('a failed adb call surfaces stderr rather than writing an empty file', async () => {
  const outPath = join(mkdtempSync(join(tmpdir(), 'baton-cap-')), 'shot.png');
  const { exec } = fakeExec({ adb: { code: 1, stdout: Buffer.alloc(0), stderr: 'device offline' } });

  await assert.rejects(
    screenshotSession(snapshot(ANDROID_SERIAL), outPath, exec),
    /device offline/,
  );
  assert.ok(!existsSync(outPath));
});

test('with no outPath given, the default lands under stateDir()/screenshots and the directory is created', async () => {
  const { stateDir } = await import('../src/core/paths.ts');
  const { exec, calls } = fakeExec({ xcrun: { code: 0, stdout: '', stderr: '' } });

  const result = await screenshotSession(snapshot(IOS_UDID), undefined, exec);

  assert.ok(result.path.startsWith(join(stateDir(), 'screenshots')));
  assert.ok(result.path.includes('proj_flutter-app'), 'the session id must be recognisable in the filename');
  assert.ok(existsSync(dirname(result.path)), 'mkdir -p must have created the directory');
  assert.equal(calls[0].args.at(-1), result.path, 'the computed default path is what actually gets passed to simctl');
});

test('the device registry\'s platformType overrides guessing from the id\'s shape', async () => {
  const registry = new DeviceRegistry('/tmp');
  // A deliberately adversarial fixture: an id shaped exactly like an iOS
  // simulator UDID, but the registry -- the actual Flutter daemon -- says it
  // is Android. Authoritative data must win over the shape-based guess.
  registry.ingest(
    JSON.stringify([{
      event: 'device.added',
      params: { id: IOS_UDID, name: 'weird-device', platform: 'android', platformType: 'android', emulator: true },
    }]) + '\n',
  );
  const device = registry.list().find((d) => d.id === IOS_UDID)!;
  assert.equal(device.platformType, 'android');

  const outPath = join(mkdtempSync(join(tmpdir(), 'baton-cap-')), 'shot.png');
  const { exec, calls } = fakeExec({ adb: { code: 0, stdout: Buffer.from([1]), stderr: '' } });

  await screenshotSession(snapshot(IOS_UDID), outPath, exec, device.platformType);

  assert.equal(calls[0].cmd, 'adb', 'the registry\'s platformType must win over the UUID-shaped guess');
});

test('with no hint at all, a UDID-shaped target still resolves to iOS by guessing', async () => {
  const outPath = join(mkdtempSync(join(tmpdir(), 'baton-cap-')), 'shot.png');
  const { exec, calls } = fakeExec({ xcrun: { code: 0, stdout: '', stderr: '' } });

  await screenshotSession(snapshot(IOS_UDID), outPath, exec);

  assert.equal(calls[0].cmd, 'xcrun');
});
