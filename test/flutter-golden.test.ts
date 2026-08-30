import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FlutterSession } from '../src/adapters/flutter.ts';
import type { LaunchConfig } from '../src/config/loader.ts';

const CONFIG: LaunchConfig = {
  name: 'iOS Simulator (DEV / dev flavor)', kind: 'flutter', cwd: '/proj',
  program: 'lib/main.dart', toolArgs: ['--flavor', 'dev'], args: [],
};

/**
 * Replay the transcript recorded from a real `flutter run --machine` against the
 * McLane360 app on a booted iPhone 17 Pro. This is the regression guard for the
 * whole premise: if Flutter changes the wire format, this test fails.
 */
test('replays a real recorded session end to end', () => {
  const s = new FlutterSession(CONFIG, {
    deviceId: '48F0A0D1-0CEC-4781-B73B-BE0F494DD23D',
    flutter: { command: 'flutter', prefixArgs: [], source: 'path' },
    spawn: () => ({ write: () => {}, kill: () => {} }),
  });
  s.start();

  const transcript = readFileSync('test/fixtures/flutter-run-lifecycle.txt', 'utf8');
  // feed it in small chunks to also exercise boundary reassembly on real data
  for (let i = 0; i < transcript.length; i += 97) s.ingest(transcript.slice(i, i + 97));

  assert.equal(s.appId, '7b213396-cc7c-4cce-91bc-e14326ea173d');
  assert.equal(s.supportsRestart, true);
  assert.equal(s.vmServiceUri, 'ws://127.0.0.1:59175/gAUXvd9h6vs=/ws');
  assert.match(s.devToolsUri!, /devtools/);
  // app.stop arrives at the end of the transcript
  assert.equal(s.status, 'stopped');

  const logs = s.recentLogs().map((l) => l.text).join('\n');
  assert.match(logs, /Reloaded 3 of 3692 libraries/);
  assert.match(logs, /Restarted application/);
});
