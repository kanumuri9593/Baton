import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep every test on its own scratch directory -- no shared state, no BATON_HOME
// needed here since LogHistory/RunLogWriter take a directory directly.
process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-logstore-home-'));

const { RunLogWriter, LogHistory, MAX_RUN_LOG_BYTES, MAX_RUNS, MAX_TOTAL_BYTES, safe } =
  await import('../src/core/log-store.ts');

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'baton-logstore-'));
}

function header(overrides: Partial<any> = {}) {
  return {
    runId: overrides.runId ?? '1000-demo-session',
    session: {
      id: 'demo/session', name: 'demo', kind: 'process', status: 'running',
      capabilities: [], startedAt: 1000, ...overrides.session,
    },
    root: overrides.root ?? '/proj/demo',
  };
}

// --- safe() -----------------------------------------------------------------

test('safe() replaces path-hostile characters with underscores', () => {
  assert.equal(safe('demo/session name!'), 'demo_session_name_');
  assert.equal(safe('a.b-c_9'), 'a.b-c_9');
});

// --- RunLogWriter + LogHistory.read round trip ------------------------------

test('writer: header + lines + exit round-trip through LogHistory.read', async () => {
  const dir = tmpDir();
  const h = header();
  const path = join(dir, `${h.runId}.jsonl`);
  const writer = new RunLogWriter(path, h);
  writer.append({ at: 1001, text: 'line one', error: false });
  writer.append({ at: 1002, text: 'line two', error: true });
  await writer.close(0);

  const history = new LogHistory(dir);
  const lines = history.read(h.runId);
  assert.deepEqual(lines, [
    { at: 1001, text: 'line one', error: false },
    { at: 1002, text: 'line two', error: true },
  ]);
});

test('list() surfaces the header fields plus exit info scraped from the tail', async () => {
  const dir = tmpDir();
  const h = header();
  const path = join(dir, `${h.runId}.jsonl`);
  const writer = new RunLogWriter(path, h);
  writer.append({ at: 1001, text: 'hi', error: false });
  await writer.close(2);

  const history = new LogHistory(dir);
  const [info] = history.list();
  assert.equal(info.runId, h.runId);
  assert.equal(info.sessionId, 'demo/session');
  assert.equal(info.name, 'demo');
  assert.equal(info.kind, 'process');
  assert.equal(info.root, '/proj/demo');
  assert.equal(info.startedAt, 1000);
  assert.equal(info.exitCode, 2);
  assert.equal(typeof info.endedAt, 'number');
  assert.equal(info.live, false);
  assert.ok(info.sizeBytes > 0);
});

test('a run with no exit record yet (still live) has no endedAt/exitCode', async () => {
  const dir = tmpDir();
  const h = header();
  const path = join(dir, `${h.runId}.jsonl`);
  const writer = new RunLogWriter(path, h);
  writer.append({ at: 1001, text: 'still going', error: false });
  await writer.flush(); // deliberately not closed -- the run is still "live"

  const history = new LogHistory(dir);
  const [info] = history.list();
  assert.equal(info.exitCode, undefined);
  assert.equal(info.endedAt, undefined);
});

// --- resolution: full id, prefix, sessionId ---------------------------------

test('read() accepts a full runId, a unique prefix, or a sessionId (latest run)', async () => {
  const dir = tmpDir();
  const older = header({ runId: '1000-demo-session', session: { startedAt: 1000 } });
  const newer = header({ runId: '2000-demo-session', session: { startedAt: 2000 } });

  const w1 = new RunLogWriter(join(dir, `${older.runId}.jsonl`), older);
  w1.append({ at: 1001, text: 'old run', error: false });
  await w1.close(0);
  const w2 = new RunLogWriter(join(dir, `${newer.runId}.jsonl`), newer);
  w2.append({ at: 2001, text: 'new run', error: false });
  await w2.close(0);

  const history = new LogHistory(dir);

  assert.deepEqual(history.read('1000-demo-session').map((l) => l.text), ['old run']);
  assert.deepEqual(history.read('2000-demo').map((l) => l.text), ['new run'], 'unique prefix resolves');
  assert.deepEqual(history.read('demo/session').map((l) => l.text), ['new run'], 'bare sessionId picks the latest run');
});

// --- tail + filter semantics, matching the live `logs` RPC ------------------

test('tail + filter: tail is applied first, then the filter, like the live logs RPC', async () => {
  const dir = tmpDir();
  const h = header();
  const path = join(dir, `${h.runId}.jsonl`);
  const writer = new RunLogWriter(path, h);
  writer.append({ at: 1, text: 'keep-1', error: false });
  writer.append({ at: 2, text: 'drop-2', error: false });
  writer.append({ at: 3, text: 'keep-3', error: false });
  await writer.close(0);

  const history = new LogHistory(dir);
  // tail:2 keeps the last two lines (drop-2, keep-3); filtering for "keep" then
  // drops drop-2, leaving only keep-3 -- proving tail ran before the filter.
  const lines = history.read(h.runId, { tail: 2, filter: 'keep' });
  assert.deepEqual(lines.map((l) => l.text), ['keep-3']);
});

test('default tail is 200 lines', async () => {
  const dir = tmpDir();
  const h = header();
  const path = join(dir, `${h.runId}.jsonl`);
  const writer = new RunLogWriter(path, h);
  for (let i = 0; i < 250; i++) writer.append({ at: i, text: `line-${i}`, error: false });
  await writer.close(0);

  const history = new LogHistory(dir);
  const lines = history.read(h.runId);
  assert.equal(lines.length, 200);
  assert.equal(lines[0].text, 'line-50');
  assert.equal(lines.at(-1)!.text, 'line-249');
});

// --- byte cap ----------------------------------------------------------------

test('byte cap: exceeding it appends one truncated marker and ignores later appends', async () => {
  const dir = tmpDir();
  const h = header();
  const path = join(dir, `${h.runId}.jsonl`);
  const writer = new RunLogWriter(path, h, { maxBytes: 100 });
  for (let i = 0; i < 20; i++) writer.append({ at: i, text: `padded line number ${i}`, error: false });
  writer.append({ at: 999, text: 'after the cap, should be dropped', error: false });
  await writer.close(0);

  const raw = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const truncatedMarkers = raw.filter((r) => r.kind === 'truncated');
  assert.equal(truncatedMarkers.length, 1, 'exactly one truncated marker');
  assert.ok(!raw.some((r) => r.text === 'after the cap, should be dropped'));

  const history = new LogHistory(dir);
  const lines = history.read(h.runId, { tail: 1000 });
  assert.ok(!lines.some((l) => l.text === 'after the cap, should be dropped'));
});

test('MAX_RUN_LOG_BYTES is the default cap and a positive number', () => {
  assert.ok(MAX_RUN_LOG_BYTES > 0);
});

// --- a broken writer degrades loudly-once, never throws ---------------------

test('a writer that cannot open its file never throws and warns once', async () => {
  const dir = tmpDir();
  const h = header();
  // A path whose parent cannot exist (a file where a directory is expected)
  // forces the underlying fs call to fail.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const path = join(blocker, 'sub', `${h.runId}.jsonl`);

  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (msg: string) => warnings.push(String(msg));
  try {
    const writer = new RunLogWriter(path, h);
    assert.doesNotThrow(() => writer.append({ at: 1, text: 'x', error: false }));
    assert.doesNotThrow(() => writer.append({ at: 2, text: 'y', error: false }));
    await assert.doesNotReject(writer.close(0));
    assert.equal(warnings.length, 1, 'exactly one warning, not one per failed write');
  } finally {
    console.error = originalError;
  }
});

// --- prune -------------------------------------------------------------------

test('prune: keeps only the newest N runs, deleting the oldest', async () => {
  const dir = tmpDir();
  for (let i = 0; i < 6; i++) {
    const h = header({ runId: `${1000 + i}-r${i}`, session: { startedAt: 1000 + i } });
    const writer = new RunLogWriter(join(dir, `${h.runId}.jsonl`), h);
    await writer.close(0);
  }
  const history = new LogHistory(dir, { maxRuns: 3, maxTotalBytes: Number.MAX_SAFE_INTEGER });
  history.prune();
  const remaining = history.list();
  assert.equal(remaining.length, 3);
  assert.deepEqual(
    remaining.map((r) => r.runId),
    ['1005-r5', '1004-r4', '1003-r3'],
    'newest three survive, newest first',
  );
});

test('prune: also enforces a total byte budget, deleting the oldest first', async () => {
  const dir = tmpDir();
  const sizes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const h = header({ runId: `${2000 + i}-r${i}`, session: { startedAt: 2000 + i } });
    const path = join(dir, `${h.runId}.jsonl`);
    const writer = new RunLogWriter(path, h);
    writer.append({ at: 1, text: 'x'.repeat(500), error: false });
    await writer.close(0);
    sizes.push(statSync(path).size);
  }
  // Budget for the newest two files only.
  const budget = sizes.at(-1)! + sizes.at(-2)! + 1;
  const history = new LogHistory(dir, { maxRuns: 100, maxTotalBytes: budget });
  history.prune();
  const remaining = history.list();
  assert.deepEqual(remaining.map((r) => r.runId), ['2003-r3', '2002-r2']);
});

// --- torn final line ----------------------------------------------------------

test('a torn final line is tolerated by read() and does not blow up list()', async () => {
  const dir = tmpDir();
  const h = header();
  const path = join(dir, `${h.runId}.jsonl`);
  const writer = new RunLogWriter(path, h);
  writer.append({ at: 1, text: 'complete line', error: false });
  await writer.close(0);
  // Simulate a crash mid-write: half a JSON line, no trailing newline.
  appendFileSync(path, '{"at":999,"text":"cut off half');

  const history = new LogHistory(dir);
  const lines = history.read(h.runId);
  assert.deepEqual(lines.map((l) => l.text), ['complete line']);

  const [info] = history.list();
  assert.equal(info.runId, h.runId, 'list() must not choke on the torn tail either');
});

// --- corrupt file skipping in list() -----------------------------------------

test('list() skips a corrupt file and orders the rest newest first', async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, 'not-json-at-all.jsonl'), 'this is not json\nnope\n');

  const older = header({ runId: '1000-a', session: { startedAt: 1000 } });
  const newer = header({ runId: '3000-b', session: { startedAt: 3000 } });
  await new RunLogWriter(join(dir, `${older.runId}.jsonl`), older).close(0);
  await new RunLogWriter(join(dir, `${newer.runId}.jsonl`), newer).close(0);

  const history = new LogHistory(dir);
  const listed = history.list();
  assert.deepEqual(listed.map((r) => r.runId), ['3000-b', '1000-a']);
});

test('list() filters by root when given one', async () => {
  const dir = tmpDir();
  const a = header({ runId: '1000-a', root: '/proj/a', session: { startedAt: 1000 } });
  const b = header({ runId: '2000-b', root: '/proj/b', session: { startedAt: 2000 } });
  await new RunLogWriter(join(dir, `${a.runId}.jsonl`), a).close(0);
  await new RunLogWriter(join(dir, `${b.runId}.jsonl`), b).close(0);

  const history = new LogHistory(dir);
  const listed = history.list('/proj/a');
  assert.deepEqual(listed.map((r) => r.runId), ['1000-a']);
});

test('sanity: exported caps are the documented defaults', () => {
  assert.equal(MAX_RUNS, 200);
  assert.equal(MAX_TOTAL_BYTES, 500 * 1024 * 1024);
  assert.equal(MAX_RUN_LOG_BYTES, 25 * 1024 * 1024);
});
