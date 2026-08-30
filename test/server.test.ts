import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the daemon's state out of the real ~/.baton.
process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-server-'));

const { LaunchDaemon, matchTarget } = await import('../src/daemon/server.ts');
const { sessionLogDir } = await import('../src/core/paths.ts');
const { LogHistory } = await import('../src/core/log-store.ts');

let daemon: InstanceType<typeof LaunchDaemon>;
let port: number;
let token: string;

before(async () => {
  daemon = new LaunchDaemon('test');
  const handshake = await daemon.listen(0);
  port = handshake.port;
  token = handshake.token;
});

after(async () => { await daemon.close(); });

/**
 * Connect and capture frames from the moment the socket exists.
 *
 * The daemon greets a client immediately, so a listener attached after `open`
 * can miss the greeting entirely.
 */
function connect(withToken: string): Promise<{ socket: WebSocket; next: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?token=${withToken}`);
    const queue: any[] = [];
    let waiter: ((value: any) => void) | undefined;

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (waiter) { waiter(message); waiter = undefined; }
      else queue.push(message);
    });
    socket.on('error', reject);
    socket.on('open', () =>
      resolve({
        socket,
        next: () =>
          queue.length
            ? Promise.resolve(queue.shift())
            : new Promise((r) => { waiter = r; }),
      }),
    );
  });
}

test('rejects a bad token at the upgrade, before any socket exists', async () => {
  await assert.rejects(connect('not-the-token'));
});

test('accepts the real token and greets with the current session list', async () => {
  const { socket, next } = await connect(token);
  const hello = await next();
  assert.equal(hello.event, 'hello');
  assert.deepEqual(hello.sessions, []);
  socket.close();
});

test('answers RPC over the socket, matching ids to replies', async () => {
  const { socket, next } = await connect(token);
  await next(); // hello
  socket.send(JSON.stringify({ id: 42, method: 'sessions' }));
  const reply = await next();
  assert.equal(reply.id, 42);
  assert.deepEqual(reply.result, []);
  socket.close();
});

test('an RPC error comes back on the same id rather than closing the socket', async () => {
  const { socket, next } = await connect(token);
  await next();
  socket.send(JSON.stringify({ id: 7, method: 'nope' }));
  const reply = await next();
  assert.equal(reply.id, 7);
  assert.match(reply.error, /unknown method/);
  assert.equal(socket.readyState, 1, 'socket must stay open after a failed call');
  socket.close();
});

test('serves the HUD and a health endpoint', async () => {
  const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as any;
  assert.equal(health.ok, true);

  const hud = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(hud, /<title>Baton<\/title>/);
  // the HUD must be self-contained: no external requests are permitted
  assert.ok(!/src="https?:\/\//.test(hud), 'HUD must not load external scripts');
});

test('unknown methods fail loudly rather than silently', async () => {
  await assert.rejects(daemon.handle({ method: 'nonsense' }), /unknown method/);
});

test('acting on a missing session names the session that was not found', async () => {
  await assert.rejects(daemon.handle({ method: 'logs', params: { session: 'ghost' } }), /ghost/);
});

test('reload --all with nothing running is a no-op, not an error', async () => {
  const results = await daemon.handle({ method: 'reload', params: { all: true } });
  assert.deepEqual(results, []);
});

test('targets discovers the real McLane360 project', async () => {
  const result: any = await daemon.handle({
    method: 'targets', params: { cwd: '/Users/yxkanum/Documents/McLane360' },
  });
  assert.equal(result.root, '/Users/yxkanum/Documents/McLane360');
  assert.ok(result.targets.length >= 16);
});

test('running an unknown target explains how to find the real ones', async () => {
  await assert.rejects(
    daemon.handle({ method: 'run', params: { target: 'no-such-target-xyz', cwd: process.cwd() } }),
    /baton list/,
  );
});

test('matchTarget prefers an exact name over a substring', () => {
  const targets = [{ name: 'dev' }, { name: 'dev:web' }];
  assert.equal(matchTarget(targets, 'dev')!.name, 'dev');
  assert.equal(matchTarget(targets, 'web')!.name, 'dev:web');
  assert.equal(matchTarget(targets, ''), undefined);
});

test('matchTarget returns undefined, not a guess, when a substring matches several targets', () => {
  const targets = [{ name: 'Dev API' }, { name: 'Staging API' }];
  assert.equal(matchTarget(targets, 'api'), undefined);
  assert.equal(matchTarget(targets, 'API'), undefined, 'case-insensitive matching stays ambiguous too');
});

test('an ambiguous run target lists the candidates instead of picking one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-ambiguous-'));
  mkdirSync(join(root, '.vscode'), { recursive: true });
  writeFileSync(
    join(root, '.vscode', 'launch.json'),
    JSON.stringify({
      version: '0.2.0',
      configurations: [
        { name: 'Dev API', runtimeExecutable: 'true', runtimeArgs: [] },
        { name: 'Staging API', runtimeExecutable: 'true', runtimeArgs: [] },
      ],
    }),
  );

  await assert.rejects(
    daemon.handle({ method: 'run', params: { target: 'api', cwd: root } }),
    /"api" matches several targets: Dev API, Staging API\. Use the full name\./,
  );
});

test('a context-free client gets the most recently used project, not the daemon cwd', async () => {
  // Simulates the HUD: a browser has no working directory of its own.
  const bare: any = await daemon.handle({ method: 'targets', params: { cwd: null } });
  assert.ok(bare.root, 'must always resolve to some project');

  // A terminal runs from a real project...
  await daemon.handle({ method: 'useProject', params: { root: '/Users/yxkanum/Documents/McLane360' } });

  // ...and the context-free client now sees that project's targets.
  const after: any = await daemon.handle({ method: 'targets', params: { cwd: null } });
  assert.equal(after.root, '/Users/yxkanum/Documents/McLane360');
  assert.ok(after.targets.length >= 16, 'the real launch configs must be reachable from the HUD');
  assert.ok(after.projects.includes('/Users/yxkanum/Documents/McLane360'));
});

test('an explicit cwd still overrides the remembered project', async () => {
  await daemon.handle({ method: 'useProject', params: { root: '/Users/yxkanum/Documents/McLane360' } });
  const result: any = await daemon.handle({ method: 'targets', params: { cwd: process.cwd() } });
  assert.equal(result.root, process.cwd());
});

test('targets reports blocking issues so the HUD can flag them', async () => {
  const result: any = await daemon.handle({
    method: 'targets', params: { cwd: '/Users/yxkanum/Documents/McLane360' },
  });
  // every flutter target carries an issues array, empty when runnable
  for (const target of result.targets) assert.ok(Array.isArray(target.issues));
});

// --- several projects at once ---------------------------------------------

test('projects lists every remembered project with what it can run', async () => {
  await daemon.handle({ method: 'useProject', params: { root: '/Users/yxkanum/Documents/McLane360' } });
  const result: any = await daemon.handle({ method: 'projects', params: {} });

  const mclane = result.projects.find((p: any) => p.root === '/Users/yxkanum/Documents/McLane360');
  assert.ok(mclane, 'a remembered project must appear in the list');
  assert.equal(mclane.name, 'McLane360', 'the HUD labels tabs with this');
  assert.ok(mclane.targets.length >= 16);
  // Targets carry their pre-flight state, so the picker can flag blocked ones
  // without a second round trip per project.
  assert.ok(mclane.targets.every((t: any) => Array.isArray(t.issues)));
});

test('adding a directory that is not a project is refused, with the path', async () => {
  await assert.rejects(
    () => daemon.handle({ method: 'addProject', params: { path: '/usr/share/dict' } }),
    /does not look like a project/,
  );
  await assert.rejects(
    () => daemon.handle({ method: 'addProject', params: { path: '/no/such/place' } }),
    /not a directory/,
  );
});

test('a project with no runnable targets yet is still worth tracking', async () => {
  // Baton itself: a real project, but no dev script to run.
  const added: any = await daemon.handle({
    method: 'addProject', params: { path: process.cwd() },
  });
  assert.equal(added.root, process.cwd());
  const listed: any = await daemon.handle({ method: 'projects', params: {} });
  assert.ok(listed.projects.some((p: any) => p.root === process.cwd()));
});

test('removing a project takes it out of the list without touching the disk', async () => {
  await daemon.handle({ method: 'addProject', params: { path: process.cwd() } });
  const result: any = await daemon.handle({ method: 'removeProject', params: { root: process.cwd() } });
  assert.equal(result.removed, true);
  const listed: any = await daemon.handle({ method: 'projects', params: {} });
  assert.ok(!listed.projects.some((p: any) => p.root === process.cwd()));
  assert.equal(
    (await daemon.handle({ method: 'removeProject', params: { root: process.cwd() } }) as any).removed,
    false,
    'removing twice is not an error, just a no-op',
  );
});

test('a bulk operation can be scoped to named sessions', async () => {
  // Nothing is running, so an empty id list must be an empty result -- not the
  // "all sessions" fallback, which would reload other projects by accident.
  const result: any = await daemon.handle({ method: 'reload', params: { ids: [] } });
  assert.deepEqual(result, []);
});

test('POST /rpc answers the same methods as the socket', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'sessions' }),
  });
  assert.equal(response.status, 200);
  const body: any = await response.json();
  assert.ok(Array.isArray(body.result));
});

test('POST /rpc without the token is refused', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'sessions' }),
  });
  assert.equal(response.status, 401);
});

// --- persistent per-run logs (T2) -------------------------------------------

/** Wait for a session to reach a terminal status. */
function waitForExit(session: { status: string; on: (event: 'change', fn: () => void) => unknown }): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (session.status === 'stopped' || session.status === 'failed') resolve();
    };
    check();
    session.on('change', check);
  });
}

test('logHistory shows a real run, logRead returns its lines, and logs falls back to disk after forget + a fresh daemon', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'baton-runlog-'));
  const target: any = {
    name: 'echo-once',
    kind: 'process',
    source: 'auto',
    cwd: scratch,
    command: process.execPath,
    args: ['-e', "console.log('hello from run'); process.exit(0)"],
  };

  const session = await daemon.registry.run(target);
  await waitForExit(session);
  // Let LogSink's queued `writer.close()` actually finish flushing before
  // reading it back through logHistory -- the session reporting `stopped` and
  // its exit record having reached disk are two different, async, events.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const history: any = await daemon.handle({ method: 'logHistory', params: {} });
  const entry = history.find((r: any) => r.sessionId === session.id);
  assert.ok(entry, 'the run must show up in logHistory once it has exited');
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.root, scratch);
  assert.equal(entry.live, false, 'a session no longer running is not live');

  const read: any = await daemon.handle({ method: 'logRead', params: { run: entry.runId } });
  assert.ok(read.some((l: any) => l.text.includes('hello from run')));

  const forgotten: any = await daemon.handle({ method: 'forget', params: { session: session.id } });
  assert.equal(forgotten.forgotten, true);

  // A brand new daemon (simulating a restart) on the same BATON_HOME must
  // still be able to serve this run's logs through the plain `logs` RPC.
  const { LaunchDaemon: FreshDaemon } = await import('../src/daemon/server.ts');
  const fresh = new FreshDaemon('test-fresh');
  const lines: any = await fresh.handle({ method: 'logs', params: { session: session.id } });
  assert.ok(lines.some((l: any) => l.text.includes('hello from run')));
});

test('an ordinary exit writes exactly one header and one exit record, not a duplicate pair', async () => {
  // The registry fires `change` twice for the same terminal status on every
  // exit (once from the session's own setStatus, once re-derived from its
  // `exit` event) -- a regression test for LogSink treating the second one
  // as a no-op instead of reopening and re-closing the same file.
  const scratch = mkdtempSync(join(tmpdir(), 'baton-runlog-dup-'));
  const target: any = {
    name: 'echo-dup', kind: 'process', source: 'auto', cwd: scratch,
    command: process.execPath, args: ['-e', "console.log('once'); process.exit(0)"],
  };

  const session = await daemon.registry.run(target);
  await waitForExit(session);
  // Let LogSink's fire-and-forget `writer.close()` actually finish flushing.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const runId = `${session.snapshot().startedAt}-${session.id.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const path = join(sessionLogDir(), `${runId}.jsonl`);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.kind === 'header').length, 1, 'exactly one header line');
  assert.equal(rows.filter((r) => r.kind === 'exit').length, 1, 'exactly one exit line');
  assert.equal(rows[0].kind, 'header', 'the header must be the first line');
});

test('logHistory reports a still-running session as live, with its current size', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'baton-runlog-live-'));
  const target: any = {
    name: 'sleeper',
    kind: 'process',
    source: 'auto',
    cwd: scratch,
    command: process.execPath,
    args: ['-e', "console.log('still going'); setTimeout(() => {}, 5000)"],
  };

  const session = await daemon.registry.run(target);
  try {
    // Give the child a moment to actually emit its log line.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const history: any = await daemon.handle({ method: 'logHistory', params: { root: scratch } });
    const entry = history.find((r: any) => r.sessionId === session.id);
    assert.ok(entry, 'a running session must appear in logHistory too');
    assert.equal(entry.live, true);
  } finally {
    await session.stop();
  }
});

// --- fix round 1: hotRestart, injected-LogHistory writes, root normalization

/** Wait for a session to reach a specific status. */
function waitForStatus(
  session: { status: string; on: (event: 'change', fn: () => void) => unknown },
  status: string,
): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (session.status === status) resolve();
    };
    check();
    session.on('change', check);
  });
}

test('hotRestart twice then stop: the run log ends with the correct final exit record, no stale metadata, and no leaked writer', async () => {
  // Reproduces the bug found in review: a hot restart reuses the session's
  // id/startedAt, hence the exact same runId/file. Before the fix, the
  // #closedRuns guard (keyed only on "have we ever closed this runId")
  // permanently blocked LogSink from closing it again -- the FIRST restart's
  // reopen (via the log-fallback path) got a fresh header but no exit ever
  // followed; a SECOND restart appended into that still-open writer with no
  // header at all; and `scanExit` then reported the stale pre-restart exit
  // record as if it were current.
  //
  // Each segment lingers so `hotRestart()`/`stop()` genuinely SIGTERM a live
  // child rather than racing its own near-instant exit -- deterministic,
  // rather than depending on exact timing.
  const scratch = mkdtempSync(join(tmpdir(), 'baton-runlog-restart-'));
  const target: any = {
    name: 'restart-me', kind: 'process', source: 'auto', cwd: scratch,
    command: process.execPath,
    args: ['-e', "console.log('segment up'); setTimeout(() => process.exit(0), 60000)"],
  };

  const session: any = await daemon.registry.run(target);
  await waitForStatus(session, 'running');

  await session.hotRestart(); // segment 1 -> segment 2
  await waitForStatus(session, 'running');

  await session.hotRestart(); // segment 2 -> segment 3
  await waitForStatus(session, 'running');

  await session.stop(); // segment 3 -> the final stop
  await waitForStatus(session, 'stopped');

  // Let every fire-and-forget `writer.close()` actually finish flushing.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const runId = `${session.snapshot().startedAt}-${session.id.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const path = join(sessionLogDir(), `${runId}.jsonl`);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const headers = rows.filter((r) => r.kind === 'header');
  const exits = rows.filter((r) => r.kind === 'exit');
  assert.equal(rows.at(-1)!.kind, 'exit', 'the file must end with an exit record, not trail off mid-segment');
  assert.equal(headers.length, exits.length, 'every opened segment must have been closed -- no leaked writer');
  assert.ok(exits.length >= 3, 'each of the three segments (initial run + two restarts) got its own exit record');

  const lastExit = exits.at(-1);
  const history: any = await daemon.handle({ method: 'logHistory', params: {} });
  const entry = history.find((r: any) => r.sessionId === session.id);
  assert.ok(entry);
  assert.equal(entry.live, false);
  assert.equal(entry.exitCode, lastExit.code, 'logHistory must report the LAST exit code, not a stale one');
  assert.equal(entry.endedAt, lastExit.at, 'logHistory must report the LAST exit time, not a stale one');
});

test('an injected LogHistory pointed at a custom directory is where LogSink actually writes, not the default sessionLogDir()', async () => {
  // Before the fix, LogSink always resolved its write path via the module-
  // level `sessionLogDir()` regardless of which LogHistory the daemon was
  // constructed with -- an injected store silently only ever saw an empty
  // history, because nothing was ever written to ITS directory.
  const customDir = mkdtempSync(join(tmpdir(), 'baton-custom-history-'));
  const customHistory = new LogHistory(customDir);
  const customDaemon = new LaunchDaemon('test-custom-history', { history: customHistory });

  const scratch = mkdtempSync(join(tmpdir(), 'baton-runlog-custom-'));
  const target: any = {
    name: 'custom-dir', kind: 'process', source: 'auto', cwd: scratch,
    command: process.execPath, args: ['-e', "console.log('elsewhere'); process.exit(0)"],
  };

  const session = await customDaemon.registry.run(target);
  await waitForExit(session);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const history: any = await customDaemon.handle({ method: 'logHistory', params: {} });
  const entry = history.find((r: any) => r.sessionId === session.id);
  assert.ok(entry, 'the run must be visible through the injected LogHistory it was constructed with');

  const filesInCustomDir = readdirSync(customDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(filesInCustomDir.length > 0, 'the run file must actually be written under the injected directory');
  assert.ok(
    !existsSync(join(sessionLogDir(), `${entry.runId}.jsonl`)),
    'must NOT have written to the default sessionLogDir() instead of the injected one',
  );
});

test('logHistory {root} normalizes a subdirectory the way targets/bootables do, instead of exact string matching', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'baton-runlog-subdir-'));
  const subdir = join(projectRoot, 'packages', 'app');
  mkdirSync(subdir, { recursive: true });
  // Make it look like a real project so findProjectRoot(subdir) resolves back up to it.
  mkdirSync(join(projectRoot, '.git'), { recursive: true });

  const target: any = {
    name: 'subdir-target', kind: 'process', source: 'auto', cwd: projectRoot,
    command: process.execPath, args: ['-e', "console.log('from a project root'); process.exit(0)"],
  };
  const session = await daemon.registry.run(target);
  await waitForExit(session);

  const history: any = await daemon.handle({ method: 'logHistory', params: { root: subdir } });
  assert.ok(
    history.some((r: any) => r.sessionId === session.id),
    'a subdirectory of the project root must still match, the same way `targets {cwd}` resolves it',
  );
});
