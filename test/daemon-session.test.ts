import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlutterSession } from '../src/adapters/flutter.ts';
import type { LaunchConfig } from '../src/config/loader.ts';

const CONFIG: LaunchConfig = {
  name: 'iOS Simulator (DEV / dev flavor)',
  kind: 'flutter',
  cwd: '/proj',
  program: 'lib/main.dart',
  toolArgs: ['--flavor', 'dev'],
  args: [],
};

/**
 * Drive a session against a scripted child instead of a real simulator, using the
 * exact line shapes captured from Flutter 3.38.2.
 */
function session() {
  const written: string[] = [];
  const s = new FlutterSession(CONFIG, {
    deviceId: 'IPHONE-17-PRO',
    flutter: { command: '/fake/flutter', prefixArgs: [], source: 'fvm-sdk' },
    spawn: () => ({ write: (line: string) => written.push(line), kill: () => {} }),
  });
  s.start();
  return { s, written };
}

/** Bring a session to the point where the app is running. */
function started(s: FlutterSession, appId = 'app-1') {
  s.ingest(`[{"event":"app.start","params":{"appId":"${appId}","deviceId":"IPHONE-17-PRO","supportsRestart":true}}]\n`);
  s.ingest(`[{"event":"app.started","params":{"appId":"${appId}"}}]\n`);
}

test('captures appId from app.start and reports running on app.started', () => {
  const { s } = session();
  assert.equal(s.status, 'starting');
  started(s);
  assert.equal(s.appId, 'app-1');
  assert.equal(s.status, 'running');
});

test('hot reload sends app.restart with fullRestart false', async () => {
  const { s, written } = session();
  started(s);
  const pending = s.hotReload();
  const sent = JSON.parse(written.at(-1)!)[0];
  assert.equal(sent.method, 'app.restart');
  assert.equal(sent.params.appId, 'app-1');
  assert.equal(sent.params.fullRestart, false);

  s.ingest(`[{"id":${sent.id},"result":{"code":0,"message":"Reloaded 1 of 500 libraries"}}]\n`);
  const result = await pending;
  assert.equal(result.code, 0);
  assert.match(result.message!, /Reloaded/);
});

test('hot restart sends app.restart with fullRestart true', async () => {
  const { s, written } = session();
  started(s);
  const pending = s.hotRestart();
  const sent = JSON.parse(written.at(-1)!)[0];
  assert.equal(sent.params.fullRestart, true);
  s.ingest(`[{"id":${sent.id},"result":{"code":0}}]\n`);
  assert.equal((await pending).code, 0);
});

test('a compile error surfaces as a structured failure and the session stays alive', async () => {
  const { s, written } = session();
  started(s);
  const pending = s.hotReload();
  const id = JSON.parse(written.at(-1)!)[0].id;
  s.ingest(`[{"id":${id},"result":{"code":1,"message":"lib/main.dart:12:3: Error: Expected ';'"}}]\n`);

  const result = await pending;
  assert.equal(result.code, 1);
  assert.match(result.message!, /Expected/);
  assert.equal(s.status, 'running', 'a failed reload must not kill the session');
});

test('a daemon error response rejects the pending request', async () => {
  const { s, written } = session();
  started(s);
  const pending = s.hotReload();
  const id = JSON.parse(written.at(-1)!)[0].id;
  s.ingest(`[{"id":${id},"error":"app 'app-1' not found"}]\n`);
  await assert.rejects(pending, /not found/);
});

test('reloading before the app has started is rejected, not silently dropped', async () => {
  const { s } = session();
  await assert.rejects(s.hotReload(), /not running|not started/i);
});

test('log events accumulate in a bounded ring buffer', () => {
  const { s } = session();
  started(s);
  for (let i = 0; i < 2500; i++) {
    s.ingest(`[{"event":"app.log","params":{"appId":"app-1","log":"line ${i}"}}]\n`);
  }
  const logs = s.recentLogs();
  assert.ok(logs.length <= 2000, `ring buffer must be bounded, got ${logs.length}`);
  assert.match(logs.at(-1)!.text, /line 2499/);
  assert.ok(!logs.some((l) => l.text.includes('line 0 ')), 'oldest entries must be evicted');
});

test('raw interleaved output is retained as log lines', () => {
  const { s } = session();
  s.ingest('Launching lib/main.dart on iPhone 17 Pro in debug mode...\n');
  assert.match(s.recentLogs().at(-1)!.text, /Launching lib\/main\.dart/);
});

test('progress events expose what the app is currently doing', () => {
  const { s } = session();
  s.ingest('[{"event":"app.progress","params":{"appId":"app-1","message":"Running Xcode build...","finished":false}}]\n');
  assert.equal(s.progress, 'Running Xcode build...');
  s.ingest('[{"event":"app.progress","params":{"appId":"app-1","message":"Running Xcode build...","finished":true}}]\n');
  assert.equal(s.progress, undefined, 'a finished progress step must clear');
});

test('child exit marks the session stopped but preserves its logs', () => {
  const { s } = session();
  started(s);
  s.ingest('[{"event":"app.log","params":{"appId":"app-1","log":"before the crash"}}]\n');
  s.handleExit(1);
  assert.equal(s.status, 'stopped');
  assert.equal(s.exitCode, 1);
  assert.match(s.recentLogs().at(-1)!.text, /before the crash/);
});

test('pending requests reject when the child dies mid-flight', async () => {
  const { s } = session();
  started(s);
  const pending = s.hotReload();
  s.handleExit(255);
  await assert.rejects(pending, /exited|died|stopped/i);
});

test('debugPort and devTools URIs are captured for out-of-band attach', () => {
  const { s } = session();
  started(s);
  s.ingest('[{"event":"app.debugPort","params":{"appId":"app-1","port":54321,"wsUri":"ws://127.0.0.1:54321/ws"}}]\n');
  s.ingest('[{"event":"app.devTools","params":{"appId":"app-1","uri":"http://127.0.0.1:9100?uri=ws://x"}}]\n');
  assert.equal(s.vmServiceUri, 'ws://127.0.0.1:54321/ws');
  assert.match(s.devToolsUri!, /^http:\/\/127\.0\.0\.1:9100/);
});

test('stop sends app.stop for the captured appId', () => {
  const { s, written } = session();
  started(s);
  void s.stop();
  const sent = JSON.parse(written.at(-1)!)[0];
  assert.equal(sent.method, 'app.stop');
  assert.equal(sent.params.appId, 'app-1');
});

test('service extensions drive the toolbar overflow options', () => {
  const { s, written } = session();
  started(s);
  void s.callServiceExtension('ext.flutter.debugPaint', { enabled: true });
  const sent = JSON.parse(written.at(-1)!)[0];
  assert.equal(sent.method, 'app.callServiceExtension');
  assert.equal(sent.params.methodName, 'ext.flutter.debugPaint');
  assert.deepEqual(sent.params.params, { enabled: true });
});

test('config.env is forwarded to the injected spawn seam', () => {
  const withEnv: LaunchConfig = { ...CONFIG, env: { FOO: 'bar' } };
  let capturedEnv: Record<string, string> | undefined;
  const s = new FlutterSession(withEnv, {
    deviceId: 'IPHONE-17-PRO',
    flutter: { command: '/fake/flutter', prefixArgs: [], source: 'fvm-sdk' },
    spawn: (_command, _args, _cwd, env) => {
      capturedEnv = env;
      return { write: () => {}, kill: () => {} };
    },
  });
  s.start();
  assert.deepEqual(capturedEnv, { FOO: 'bar' });
});

test('a config with no env entries leaves the spawn seam env argument undefined', () => {
  let capturedEnv: Record<string, string> | undefined = { should: 'be overwritten' };
  const s = new FlutterSession(CONFIG, {
    deviceId: 'IPHONE-17-PRO',
    flutter: { command: '/fake/flutter', prefixArgs: [], source: 'fvm-sdk' },
    spawn: (_command, _args, _cwd, env) => {
      capturedEnv = env;
      return { write: () => {}, kill: () => {} };
    },
  });
  s.start();
  assert.equal(capturedEnv, undefined);
});

test('request ids are unique per session', () => {
  const { s, written } = session();
  started(s);
  void s.hotReload();
  void s.hotRestart();
  const ids = written.map((w) => JSON.parse(w)[0].id);
  assert.equal(new Set(ids).size, ids.length);
});
