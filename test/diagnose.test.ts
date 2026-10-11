import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseFrames, diagnose, formatDiagnose } from '../src/daemon/diagnose.ts';
import { NetworkStore } from '../src/core/network-store.ts';
import type { LogLine, Session } from '../src/core/types.ts';

const ROOT = '/work/fieldapp-api';

function fakeSession(id: string, logs: LogLine[], root = ROOT): Session {
  return { id, root, status: 'running', recentLogs: () => logs } as unknown as Session;
}

/** What a Node service prints for one unhandled exception: a log line, then the error and its stack on stderr. */
function crash(at: number): LogLine[] {
  return [
    { at, text: `2026-10-11T16:27:${String(at % 60).padStart(2, '0')}.000Z error unhandled exception in GET /api/orders/13`, error: true },
    { at: at + 1, text: "TypeError: Cannot read properties of undefined (reading 'net')", error: true },
    { at: at + 1, text: `    at orderTotal (file://${ROOT}/server.mjs:16:23)`, error: true },
    { at: at + 1, text: `    at Server.<anonymous> (file://${ROOT}/server.mjs:38:43)`, error: true },
    { at: at + 1, text: '    at Server.emit (node:events:514:28)', error: true },
    { at: at + 1, text: '    at parserOnIncoming (node:_http_server:1293:12)', error: true },
    { at: at + 1, text: '    at HTTPParser.parserOnHeadersComplete (node:_http_common:125:17)', error: true },
  ];
}

test('repeats collapse into one counted finding, and a stack belongs to its error', () => {
  const logs: LogLine[] = [];
  for (let i = 0; i < 7; i++) {
    logs.push({ at: 100 * i, text: `GET /api/orders/${i} 200 1.2ms`, error: false }, ...crash(100 * i + 10));
  }
  const r = diagnose([fakeSession('fieldapp/api', logs)], new NetworkStore(), {});
  assert.equal(r.total, 2);
  assert.equal(r.truncated, false);
  assert.equal(r.sessions.length, 1);
  const [s] = r.sessions;
  assert.equal(s.session, 'fieldapp/api');
  assert.equal(s.root, ROOT);
  const [error, line] = s.findings;
  assert.equal(error.message, "TypeError: Cannot read properties of undefined (reading 'net')");
  assert.equal(error.count, 7);
  assert.equal(error.at, 611);
  assert.equal(error.firstAt, 11);
  assert.deepEqual(error.frames, ['at orderTotal (./server.mjs:16:23)', 'at Server.<anonymous> (./server.mjs:38:43)']);
  assert.equal(error.moreFrames, 3);
  assert.match(line.message, /error unhandled exception in GET \/api\/orders\/13$/);
  assert.equal(line.count, 7);
  assert.equal(line.frames, undefined);
  // Neither the session nor the root is repeated per finding.
  assert.ok(!('session' in error) && !('root' in error));
});

test('the text form names each session once and keeps what is needed to act', () => {
  const logs = [...crash(10), ...crash(500)];
  const text = formatDiagnose(diagnose([fakeSession('fieldapp/api', logs)], new NetworkStore(), {}));
  const lines = text.split('\n');
  assert.equal(lines[0], '2 findings, newest first');
  assert.equal(lines[1], `fieldapp/api  running  ${ROOT}`);
  assert.equal(text.split(ROOT).length - 1, 1, 'the project root appears once');
  assert.match(text, /log ×2 since \d\d:\d\d:\d\d\.\d{3}Z {2}TypeError: Cannot read properties of undefined \(reading 'net'\)/);
  assert.match(text, /\n {6}at orderTotal \(\.\/server\.mjs:16:23\)\n {6}at Server\.<anonymous> \(\.\/server\.mjs:38:43\)\n {6}\+3 more frames/);
});

test('limit counts distinct findings, newest first across sessions, and marks truncation', () => {
  const a = fakeSession('fieldapp/api', [
    { at: 1, text: 'Error: one', error: true },
    { at: 3, text: 'Error: three', error: true },
  ]);
  const b = fakeSession('fieldapp/web', [{ at: 2, text: 'Error: two', error: true }], '/work/fieldapp-web');
  const r = diagnose([a, b], new NetworkStore(), { limit: 2 });
  assert.equal(r.total, 3);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.sessions.map((s) => s.findings.map((f) => f.message)), [['Error: three'], ['Error: two']]);
  assert.match(formatDiagnose(r), /^3 findings, newest first \(showing 2; raise limit or add a query for more\)/);
});

test('a query matches an error by its stack, and network failures keep their trace ids', () => {
  const store = new NetworkStore();
  store.upsert('fieldapp/api', { id: 'r1', method: 'GET', uri: 'http://x/a', statusCode: 503, startTime: 50, durationMs: 4, traceId: 't1' } as any);
  store.upsert('fieldapp/api', { id: 'r2', method: 'GET', uri: 'http://x/a', statusCode: 503, startTime: 60, durationMs: 9, traceId: 't2' } as any);
  const session = fakeSession('fieldapp/api', crash(10));
  const byFrame = diagnose([session], store, { query: 'server.mjs:16' });
  assert.deepEqual(byFrame.sessions[0].findings.map((f) => f.message), ["TypeError: Cannot read properties of undefined (reading 'net')"]);
  const net = diagnose([session], store, { query: 'http://x/a' }).sessions[0].findings;
  assert.deepEqual(net.map((f) => f.traceId), ['t2', 't1'], 'different traces stay separate findings');
});

test('collapseFrames keeps app frames, falls back to the first frames, and counts the rest', () => {
  assert.deepEqual(collapseFrames([]), { frames: [] });
  assert.deepEqual(
    collapseFrames(['    at a (node:events:1:1)', '    at b (node:net:2:2)', '    at c (node:x:3:3)', '    at d (node:y:4:4)']),
    { frames: ['at a (node:events:1:1)', 'at b (node:net:2:2)', 'at c (node:x:3:3)'], moreFrames: 1 },
  );
  assert.deepEqual(
    collapseFrames(['#0      main (package:fieldapp/main.dart:5:3)', '#1      _run (dart:async/zone.dart:1:1)']),
    { frames: ['#0      main (package:fieldapp/main.dart:5:3)'], moreFrames: 1 },
  );
});
