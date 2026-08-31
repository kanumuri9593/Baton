import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// Keep the daemon's state out of the real ~/.baton.
process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-server-'));

const { LaunchDaemon, matchTarget } = await import('../src/daemon/server.ts');
const { sessionLogDir } = await import('../src/core/paths.ts');
const { LogHistory } = await import('../src/core/log-store.ts');
const { FlutterSession } = await import('../src/adapters/flutter.ts');
import type { LaunchConfig } from '../src/config/loader.ts';

let daemon: InstanceType<typeof LaunchDaemon>;
let port: number;
let token: string;

before(async () => {
  daemon = new LaunchDaemon('test');
  const handshake = await daemon.listen(0);
  port = handshake.port;
  token = handshake.token;
});

after(async () => {
  // A Flutter session driven by hand (no real child process) never answers
  // `app.stop`, and `stopAll()` awaits that answer forever. Retire every
  // still-live one the way a real exit would, exactly as network-service.test.ts
  // does for the same reason.
  for (const session of daemon.registry.list()) {
    (session as { handleExit?: (code: number) => void }).handleExit?.(0);
  }
  await daemon.close();
});

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

test('a project with nothing runnable asks to be configured instead of being tracked as empty', async () => {
  // A real project directory, but nothing Baton knows how to run in it. The
  // honest answer is "this needs a launch config", not an empty tab in the HUD
  // that looks broken -- so it is described, and only remembered once it has
  // something to offer.
  const root = mkdtempSync(join(tmpdir(), 'baton-needsconfig-'));
  mkdirSync(join(root, '.git'));

  const added: any = await daemon.handle({ method: 'addProject', params: { path: root } });
  assert.equal(added.root, root);
  assert.deepEqual(added.targets, []);
  assert.equal(added.needsConfig, true);

  const listed: any = await daemon.handle({ method: 'projects', params: {} });
  assert.ok(
    !listed.projects.some((p: any) => p.root === root),
    'a project with nothing runnable is not remembered until it has a config',
  );
});

test('a project with something runnable is remembered, with no needsConfig flag', async () => {
  const root = runnableProject();
  const added: any = await daemon.handle({ method: 'addProject', params: { path: root } });
  assert.equal(added.needsConfig, undefined);
  assert.ok(added.targets.length > 0);
  const listed: any = await daemon.handle({ method: 'projects', params: {} });
  assert.ok(listed.projects.some((p: any) => p.root === root));
});

test('removing a project takes it out of the list without touching the disk', async () => {
  const root = runnableProject();
  await daemon.handle({ method: 'addProject', params: { path: root } });
  const result: any = await daemon.handle({ method: 'removeProject', params: { root } });
  assert.equal(result.removed, true);
  const listed: any = await daemon.handle({ method: 'projects', params: {} });
  assert.ok(!listed.projects.some((p: any) => p.root === root));
  assert.equal(
    (await daemon.handle({ method: 'removeProject', params: { root } }) as any).removed,
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

// --- opening a project, and configuring it in place (T4) ---------------------

/** A real project with one runnable dev script -- enough to be worth remembering. */
function runnableProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'baton-project-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'vite' }, devDependencies: { vite: '5.0.0' },
  }));
  return root;
}

test('browseDirs lists a directory, flags the projects in it, and offers a way back out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-browse-rpc-'));
  mkdirSync(join(root, 'an-app'));
  writeFileSync(join(root, 'an-app', 'package.json'), '{}');
  mkdirSync(join(root, '.hidden'));

  const result: any = await daemon.handle({ method: 'browseDirs', params: { path: root } });
  assert.equal(result.path, root);
  assert.ok(result.parent, 'the parent must be offered');
  assert.deepEqual(result.entries.map((e: any) => e.name), ['an-app']);
  assert.equal(result.entries[0].isProject, true);
  assert.equal(result.entries[0].hasLaunchJson, false);
  assert.ok(result.shortcuts.length > 0);
});

test('browseDirs with no path starts at home rather than the daemon working directory', async () => {
  const result: any = await daemon.handle({ method: 'browseDirs', params: {} });
  assert.equal(result.path, homedir());
});

test('browseDirs reports an unreachable path instead of failing the call', async () => {
  const result: any = await daemon.handle({
    method: 'browseDirs', params: { path: join(tmpdir(), 'baton-not-here-xyz') },
  });
  assert.match(result.error, /no such directory/);
  assert.deepEqual(result.entries, []);
});

test('readLaunchConfig on a project with no launch.json says so without inventing one', async () => {
  const root = runnableProject();
  const result: any = await daemon.handle({ method: 'readLaunchConfig', params: { root } });
  assert.equal(result.file, null);
  assert.equal(result.text, null);
  assert.deepEqual(result.configs, []);
  assert.deepEqual(result.parseErrors, []);
});

test('readLaunchConfig returns the raw text, the parsed configs and their pre-flight issues', async () => {
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), [
    '{',
    '  // kept',
    '  "version": "0.2.0",',
    '  "configurations": [',
    '    { "name": "Sim DEV", "type": "dart", "program": "lib/main.dart",',
    '      "toolArgs": ["--dart-define-from-file=env/missing.json"] }',
    '  ]',
    '}',
  ].join('\n'));

  const result: any = await daemon.handle({ method: 'readLaunchConfig', params: { root } });
  assert.equal(result.file, join(root, '.vscode', 'launch.json'));
  assert.ok(result.text.includes('// kept'), 'the editor needs the file exactly as written');
  assert.equal(typeof result.mtimeMs, 'number');
  assert.equal(result.configs.length, 1);
  assert.equal(result.configs[0].kind, 'flutter');
  assert.equal(result.issues['Sim DEV'].length, 1, 'a missing dart-define file is reported per config');
  assert.match(result.issues['Sim DEV'][0].path, /env\/missing\.json/);
});

test('readLaunchConfig on a malformed file still hands back the text, so it can be fixed', async () => {
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), '{ "configurations": [ { "name": }\n');

  const result: any = await daemon.handle({ method: 'readLaunchConfig', params: { root } });
  assert.ok(result.text.includes('"configurations"'));
  assert.deepEqual(result.configs, []);
  assert.ok(result.parseErrors.length > 0);
  assert.equal(typeof result.parseErrors[0].line, 'number');
});

test('readLaunchConfig treats a file with no configurations array as a parse problem, not silence', async () => {
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), '{ "version": "0.2.0" }\n');
  const result: any = await daemon.handle({ method: 'readLaunchConfig', params: { root } });
  assert.deepEqual(result.configs, []);
  assert.ok(result.parseErrors.length > 0);
  assert.match(result.parseErrors[0].message, /configurations/);
});

test('generateLaunchConfig previews a file without writing anything', async () => {
  const root = runnableProject();
  const result: any = await daemon.handle({ method: 'generateLaunchConfig', params: { root } });
  assert.match(result.text, /Generated by Baton/);
  assert.ok(result.targets.some((t: any) => t.name === 'npm dev'));
  assert.ok(result.targets.every((t: any) => Array.isArray(t.issues)));
  assert.ok(!existsSync(join(root, '.vscode')), 'a preview must not touch the disk');
});

test('writeLaunchConfig saves the file, remembers the project, and reports what it now runs', async () => {
  const root = runnableProject();
  const preview: any = await daemon.handle({ method: 'generateLaunchConfig', params: { root } });
  const result: any = await daemon.handle({
    method: 'writeLaunchConfig', params: { root, text: preview.text },
  });

  assert.equal(result.file, join(root, '.vscode', 'launch.json'));
  assert.equal(typeof result.mtimeMs, 'number');
  assert.ok(result.configs.some((c: any) => c.name === 'npm dev'));
  assert.deepEqual(result.issues, { 'npm dev': [] });

  const listed: any = await daemon.handle({ method: 'projects', params: {} });
  assert.ok(
    listed.projects.some((p: any) => p.root === root),
    'saving a config is the moment a project becomes worth remembering',
  );
});

test('writeLaunchConfig can be told to use .claude instead of .vscode', async () => {
  const root = runnableProject();
  const result: any = await daemon.handle({
    method: 'writeLaunchConfig',
    params: { root, text: '{ "version": "0.2.0", "configurations": [] }\n', file: 'claude' },
  });
  assert.equal(result.file, join(root, '.claude', 'launch.json'));
});

test('writeLaunchConfig defaults to the file the project already uses, never shadowing it', async () => {
  const root = runnableProject();
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'launch.json'), '{ "configurations": [] }\n');
  const result: any = await daemon.handle({
    method: 'writeLaunchConfig',
    params: { root, text: '{ "configurations": [{ "name": "x", "runtimeExecutable": "true" }] }\n' },
  });
  assert.equal(result.file, join(root, '.claude', 'launch.json'));
  assert.ok(
    !existsSync(join(root, '.vscode', 'launch.json')),
    'a .vscode file would silently take precedence over the one being edited',
  );
});

test('writeLaunchConfig refuses invalid JSONC and reports a stale mtime as a conflict', async () => {
  const root = runnableProject();
  await assert.rejects(
    daemon.handle({ method: 'writeLaunchConfig', params: { root, text: '{ "configurations": [ }' } }),
    /invalid JSONC: \d+:\d+/,
  );

  const first: any = await daemon.handle({
    method: 'writeLaunchConfig', params: { root, text: '{ "configurations": [] }\n' },
  });
  await assert.rejects(
    daemon.handle({
      method: 'writeLaunchConfig',
      params: { root, text: '{ "configurations": [] }\n', expectedMtimeMs: first.mtimeMs - 1000 },
    }),
    /conflict: file changed on disk/,
  );
  // The same call without the guard is the "overwrite anyway" the HUD offers.
  const forced: any = await daemon.handle({
    method: 'writeLaunchConfig', params: { root, text: '{ "configurations": [] }\n' },
  });
  assert.equal(typeof forced.mtimeMs, 'number');
});

test('editLaunchConfig changes one value and leaves every comment in the file', async () => {
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  const file = join(root, '.vscode', 'launch.json');
  writeFileSync(file, [
    '{',
    '  // a comment nobody wants to lose',
    '  "configurations": [',
    '    { "name": "Sim DEV", "type": "dart", "program": "lib/main.dart" }',
    '  ]',
    '}',
  ].join('\n') + '\n');

  const result: any = await daemon.handle({
    method: 'editLaunchConfig',
    params: { root, edits: [{ path: ['configurations', 0, 'deviceId'], value: 'macos' }] },
  });
  assert.equal(result.file, file);
  assert.equal(result.configs[0].deviceId, 'macos');

  const onDisk = readFileSync(file, 'utf8');
  assert.ok(onDisk.includes('// a comment nobody wants to lose'));
  assert.ok(onDisk.includes('"program": "lib/main.dart"'));
});

test('editLaunchConfig on a project with no launch.json explains what to do instead', async () => {
  const root = runnableProject();
  await assert.rejects(
    daemon.handle({ method: 'editLaunchConfig', params: { root, edits: [] } }),
    /no launch\.json/,
  );
});

test('validateLaunchConfig checks text without writing it', async () => {
  const root = runnableProject();
  const bad: any = await daemon.handle({
    method: 'validateLaunchConfig', params: { root, text: '{ "configurations": [ }' },
  });
  assert.ok(bad.parseErrors.length > 0);
  assert.equal(typeof bad.parseErrors[0].line, 'number');
  assert.deepEqual(bad.issues, {});

  const good: any = await daemon.handle({
    method: 'validateLaunchConfig',
    params: {
      root,
      text: '{ "configurations": [ { "name": "Sim", "type": "dart", ' +
        '"toolArgs": ["--dart-define-from-file=env/nope.json"] } ] }',
    },
  });
  assert.deepEqual(good.parseErrors, []);
  assert.equal(good.issues['Sim'].length, 1);
  assert.ok(!existsSync(join(root, '.vscode')), 'validation must never write');
});

test('a written launch.json is what the project then runs', async () => {
  const root = runnableProject();
  const preview: any = await daemon.handle({ method: 'generateLaunchConfig', params: { root } });
  await daemon.handle({ method: 'writeLaunchConfig', params: { root, text: preview.text } });

  const targets: any = await daemon.handle({ method: 'targets', params: { cwd: root } });
  const fromFile = targets.targets.filter((t: any) => t.source === 'launch.json');
  assert.ok(fromFile.some((t: any) => t.name === 'npm dev'), 'the generated file must round-trip into targets');
  assert.equal(
    targets.targets.filter((t: any) => t.name === 'npm dev').length, 1,
    'the generated config must absorb the package.json target it came from, not double it',
  );
});

test('readLaunchConfig indexes each config by its place in the raw file, skipping nameless entries', async () => {
  // A nameless entry is dropped from `configs` (as the loader drops it), so the
  // list index and the file index diverge -- an edit addressed by list index
  // would land on the wrong configuration.
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), JSON.stringify({
    configurations: [
      { type: 'dart' },
      { name: 'first', type: 'dart' },
      { name: 'second', runtimeExecutable: 'true' },
    ],
  }));
  const result: any = await daemon.handle({ method: 'readLaunchConfig', params: { root } });
  assert.deepEqual(result.configs.map((c: any) => c.name), ['first', 'second']);
  assert.deepEqual(result.configIndexes, [1, 2]);
});

test('an edit addressed by the reported index changes that configuration and no other', async () => {
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), JSON.stringify({
    configurations: [
      { type: 'dart' },
      { name: 'first', type: 'dart' },
      { name: 'second', type: 'dart' },
    ],
  }, null, 2) + '\n');

  const view: any = await daemon.handle({ method: 'readLaunchConfig', params: { root } });
  const index = view.configIndexes[view.configs.findIndex((c: any) => c.name === 'second')];
  const edited: any = await daemon.handle({
    method: 'editLaunchConfig',
    params: { root, edits: [{ path: ['configurations', index, 'program'], value: 'lib/two.dart' }] },
  });
  assert.equal(edited.configs.find((c: any) => c.name === 'second').program, 'lib/two.dart');
  assert.equal(edited.configs.find((c: any) => c.name === 'first').program, undefined);
});

test('appending a configuration goes after a trailing nameless entry, not on top of it', async () => {
  // configCount is the raw array length; configIndexes.at(-1) + 1 is not. With
  // an unnamed trailing entry the two differ, and appending at the wrong one
  // replaces that entry instead of adding after it.
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), JSON.stringify({
    configurations: [{ name: 'first', type: 'dart' }, { type: 'dart', program: 'orphan.dart' }],
  }, null, 2) + '\n');

  const view: any = await daemon.handle({ method: 'readLaunchConfig', params: { root } });
  assert.equal(view.configCount, 2);
  assert.deepEqual(view.configIndexes, [0], 'the nameless entry is not a config');

  await daemon.handle({
    method: 'editLaunchConfig',
    params: {
      root,
      edits: [{ path: ['configurations', view.configCount], value: { name: 'second', type: 'dart' } }],
    },
  });

  const after: any = await daemon.handle({ method: 'readLaunchConfig', params: { root } });
  assert.equal(after.configCount, 3, 'the entry must have been added, not substituted');
  assert.deepEqual(after.configs.map((c: any) => c.name), ['first', 'second']);
  assert.ok(readFileSync(after.file, 'utf8').includes('orphan.dart'), 'the nameless entry survives');
});

test('editLaunchConfig rejects a malformed edit with something the caller can act on', async () => {
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), '{ "configurations": [] }\n');
  await assert.rejects(
    daemon.handle({ method: 'editLaunchConfig', params: { root, edits: [{ value: 1 }] } }),
    /each edit needs a `path` array/,
  );
});

test('writeLaunchConfig refuses text that is not a launch.json, and does not remember the project', async () => {
  // The MCP `write_launch_config` tool takes free text from an agent. Before the
  // shape check, `[]` replaced a working file, reported success, and the daemon
  // remembered the project -- a destroyed config that looks like a clean write.
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  const file = join(root, '.vscode', 'launch.json');
  const good = '{ "configurations": [{ "name": "keep me", "type": "dart" }] }\n';
  writeFileSync(file, good);

  for (const bad of ['[]', '"hi"', 'null', '{ "version": "0.2.0" }']) {
    await assert.rejects(
      daemon.handle({ method: 'writeLaunchConfig', params: { root, text: bad } }),
      /not a launch\.json/,
      `${bad} must be refused`,
    );
  }
  assert.equal(readFileSync(file, 'utf8'), good, 'the working file must be untouched');
  const listed: any = await daemon.handle({ method: 'projects', params: {} });
  assert.ok(
    !listed.projects.some((p: any) => p.root === root),
    'a refused write must not remember the project as configured',
  );
});

test('browseDirs answers a non-string path instead of failing the call', async () => {
  const result: any = await daemon.handle({ method: 'browseDirs', params: { path: 123 } });
  assert.equal(typeof result.path, 'string');
  assert.ok(Array.isArray(result.entries), 'never throws means never throws, whatever arrives');
});

test('editLaunchConfig rejects a path element that cannot address a node', async () => {
  const root = runnableProject();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), '{ "configurations": [] }\n');
  await assert.rejects(
    daemon.handle({
      method: 'editLaunchConfig',
      params: { root, edits: [{ path: ['configurations', {}], value: 1 }] },
    }),
    /path elements must be/,
  );
});

// --- T5: screenshot / wait / summary -----------------------------------------

const FLUTTER_CONFIG: LaunchConfig = {
  name: 'iOS Simulator (DEV)',
  kind: 'flutter',
  cwd: '/proj/t5',
  program: 'lib/main.dart',
  toolArgs: [],
  args: [],
};

/**
 * A Flutter session driven by hand, the way `daemon-session.test.ts` and
 * `network-service.test.ts` do: adopted directly (skipping device selection),
 * fed machine-protocol lines instead of a real `flutter run --machine` child.
 */
function flutterSession(name: string) {
  const written: string[] = [];
  const session = new FlutterSession({ ...FLUTTER_CONFIG, name }, {
    deviceId: 'IPHONE-17-PRO',
    flutter: { command: '/fake/flutter', prefixArgs: [], source: 'fvm-sdk' },
    spawn: () => ({ write: (line: string) => written.push(line), kill: () => {} }),
  });
  // `start()` is what wires up the fake child (`#child`) that `hotReload` and
  // `hotRestart` write to -- without it their requests silently go nowhere.
  session.start();
  daemon.registry.adopt(session, FLUTTER_CONFIG.cwd);
  session.ingest(
    `[{"event":"app.start","params":{"appId":"app-t5","deviceId":"IPHONE-17-PRO","supportsRestart":true}}]\n`,
  );
  return { session, written };
}

test('screenshot refuses a session with no screenshot capability, by name', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'baton-screenshot-'));
  const target: any = {
    name: 'no-screenshot', kind: 'process', source: 'auto', cwd: scratch,
    command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'],
  };
  const session = await daemon.registry.run(target);
  try {
    await assert.rejects(
      daemon.handle({ method: 'screenshot', params: { session: session.id } }),
      /screenshot/i,
    );
  } finally {
    await session.stop();
  }
});

test('wait resolves via the daemon once app.started arrives on a replayed Flutter session', async () => {
  const { session } = flutterSession('wait-me');
  assert.equal(session.status, 'starting');

  const pending = daemon.handle({ method: 'wait', params: { session: session.id, until: 'running', timeoutMs: 2000 } });
  session.ingest('[{"event":"app.started","params":{"appId":"app-t5"}}]\n');

  const result: any = await pending;
  assert.equal(result.met, true);
  assert.equal(result.status, 'running');
});

test('wait throws immediately, with errors attached, when the session fails instead of reaching running', async () => {
  const { session } = flutterSession('wait-fails');
  const pending = daemon.handle({ method: 'wait', params: { session: session.id, until: 'running', timeoutMs: 5000 } });
  session.ingest('[{"event":"app.log","params":{"log":"Error: lib/main.dart:12:3: compile error","error":true}}]\n');
  session.handleExit(1);

  await assert.rejects(pending, (err: Error) => {
    assert.match(err.message, /session is failed/);
    assert.match(err.message, /compile error/);
    return true;
  });
});

test('summary reflects a reload result after a reload driven through the daemon', async () => {
  const { session, written } = flutterSession('summary-me');
  session.ingest('[{"event":"app.started","params":{"appId":"app-t5"}}]\n');

  const before: any = await daemon.handle({ method: 'summary', params: { session: session.id } });
  assert.equal(before.session.id, session.id);
  assert.equal(before.lastOperation, undefined, 'no reload has happened yet');
  assert.ok(before.uptimeMs >= 0);
  assert.equal(before.recentErrors.length, 0);

  const pending = daemon.handle({ method: 'reload', params: { session: session.id } });
  const sent = JSON.parse(written.at(-1)!)[0];
  session.ingest(`[{"id":${sent.id},"result":{"code":0,"message":"Reloaded 1 of 500 libraries"}}]\n`);
  await pending;

  const after: any = await daemon.handle({ method: 'summary', params: { session: session.id } });
  assert.equal(after.lastOperation.kind, 'reload');
  assert.equal(after.lastOperation.ok, true);
  assert.match(after.lastOperation.message, /Reloaded/);
  assert.equal(after.network, undefined, 'this session never attached network capture');
});
