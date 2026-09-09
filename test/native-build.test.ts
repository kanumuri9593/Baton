import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  NativeBuildSession, type NativeSpawnFn, findAndroidApplicationId, findBuiltApp, withIosDestination,
} from '../src/adapters/native-build.ts';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  killed = false;
  hang: boolean;
  code: number;
  stdoutText: string;

  constructor(hang: boolean, code: number, stdoutText = '') {
    super();
    this.hang = hang;
    this.code = code;
    this.stdoutText = stdoutText;
  }

  kill(): boolean {
    this.killed = true;
    this.#finish(0);
    return true;
  }

  start(): void {
    if (this.stdoutText) this.stdout.end(this.stdoutText);
    if (this.hang) return;
    queueMicrotask(() => this.#finish(this.code));
  }

  #finish(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code);
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'baton-native-run-'));
}

async function waitFor(session: NativeBuildSession, status: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (session.status !== status) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}, was ${session.status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function scriptedSpawn(script: (command: string, args: string[]) => { hang?: boolean; code?: number; stdout?: string }): NativeSpawnFn {
  return (command, args) => {
    const spec = script(command, args);
    const child = new FakeChild(spec.hang === true, spec.code ?? 0, spec.stdout ?? '');
    queueMicrotask(() => child.start());
    return child as unknown as ChildProcess;
  };
}

test('withIosDestination pins the selected simulator and a private DerivedData', () => {
  const args = withIosDestination(
    ['-project', 'Demo.xcodeproj', '-scheme', 'Demo', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', 'build'],
    'UDID-1',
    '/tmp/dd',
  );
  assert.deepEqual(args, [
    '-project', 'Demo.xcodeproj', '-scheme', 'Demo',
    '-destination', 'id=UDID-1', '-derivedDataPath', '/tmp/dd', 'CODE_SIGNING_ALLOWED=NO', 'build',
  ]);
});

test('findBuiltApp prefers an iphonesimulator product and ignores tests', () => {
  const root = scratch();
  mkdirSync(join(root, 'Build', 'Products', 'Debug-iphonesimulator', 'Demo.app'), { recursive: true });
  mkdirSync(join(root, 'Build', 'Products', 'Debug-iphonesimulator', 'DemoTests.app'), { recursive: true });
  assert.equal(findBuiltApp(root), join(root, 'Build', 'Products', 'Debug-iphonesimulator', 'Demo.app'));
  rmSync(root, { recursive: true, force: true });
});

test('findAndroidApplicationId reads Gradle output-metadata.json', () => {
  const root = scratch();
  const dir = join(root, 'app', 'build', 'outputs', 'apk', 'debug');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'output-metadata.json'), JSON.stringify({ applicationId: 'com.demo.app' }));
  assert.equal(findAndroidApplicationId(root), 'com.demo.app');
  rmSync(root, { recursive: true, force: true });
});

test('an iOS session builds, installs, launches and stays running until stop', async () => {
  const cwd = scratch();
  const app = join(cwd, '.baton', 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator', 'Demo.app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'Info.plist'), '');
  const seen: string[] = [];
  const session = NativeBuildSession.create('ios', 'iOS Simulator · Demo', {
    cwd, command: 'xcodebuild', args: ['-project', 'Demo.xcodeproj', '-scheme', 'Demo', 'build'],
    deviceId: 'SIM-UDID',
    spawnFn: scriptedSpawn((command, args) => {
      seen.push([command, ...args].join(' '));
      return {
        hang: command === 'xcrun' && args.includes('launch'),
        stdout: args.includes('CFBundleIdentifier') ? 'com.demo.app' : '',
      };
    }),
  });

  session.start();
  await waitFor(session, 'running');
  assert.equal(session.snapshot().target, 'SIM-UDID');
  assert.ok(seen.some((line) => line.includes('simctl install SIM-UDID')));
  assert.ok(seen.some((line) => line.includes('simctl launch --console SIM-UDID com.demo.app')));
  await session.stop();
  assert.equal(session.status, 'stopped');
  rmSync(cwd, { recursive: true, force: true });
});

test('an Android session installDebugs, launches the package and follows logcat', async () => {
  const cwd = scratch();
  mkdirSync(join(cwd, 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true });
  writeFileSync(
    join(cwd, 'app', 'build', 'outputs', 'apk', 'debug', 'output-metadata.json'),
    JSON.stringify({ applicationId: 'com.demo.app' }),
  );
  const seen: string[] = [];
  const session = NativeBuildSession.create('android', 'Android · app debug', {
    cwd, command: './gradlew', args: [':app:installDebug'], deviceId: 'emulator-5554',
    spawnFn: scriptedSpawn((command, args) => {
      seen.push([command, ...args].join(' '));
      return {
        hang: command === 'adb' && args.includes('logcat'),
        stdout: args.includes('pidof') ? '9911' : '',
      };
    }),
  });
  session.start();
  await waitFor(session, 'running');
  assert.ok(seen.some((line) => line.includes('monkey') && line.includes('com.demo.app')));
  assert.ok(seen.some((line) => line.includes('logcat --pid 9911')));
  await session.stop();
  assert.equal(session.status, 'stopped');
  rmSync(cwd, { recursive: true, force: true });
});

test('a library-only Android target refuses to pretend it launched an app', async () => {
  const cwd = scratch();
  const session = NativeBuildSession.create('android', 'Android · Gradle build', {
    cwd, command: './gradlew', args: ['build'], deviceId: 'emulator-5554',
    spawnFn: scriptedSpawn(() => ({ code: 0 })),
  });
  session.start();
  await waitFor(session, 'failed');
  assert.match(session.recentLogs().map((line) => line.text).join('\n'), /only compiles/i);
  rmSync(cwd, { recursive: true, force: true });
});
