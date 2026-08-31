import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the daemon's state out of the real ~/.baton.
process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-network-'));

const { LaunchDaemon } = await import('../src/daemon/server.ts');
const { VmServiceClient } = await import('../src/vm/vm-client.ts');
const { FlutterSession } = await import('../src/adapters/flutter.ts');
import type { VmTransport } from '../src/vm/vm-client.ts';
import type { LaunchConfig } from '../src/config/loader.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `app.debugPort` line the real McLane360 run produced, reused verbatim. */
const LIFECYCLE = readFileSync(join(import.meta.dirname, 'fixtures', 'flutter-run-lifecycle.txt'), 'utf8')
  .split('\n');
const line = (event: string) => LIFECYCLE.find((l) => l.includes(`"event":"${event}"`))!;

const ISOLATE = 'isolates/1963006521159535';
/** The isolate a hot restart creates; request numbers start again from 1 in it. */
const SECOND_ISOLATE = 'isolates/7215544120983311';

/**
 * A VM service that answers from memory, and can be told to invent traffic.
 *
 * Everything the monitor needs, with no socket: the daemon is constructed with a
 * `createClient` that hands out one of these.
 */
class FakeVm implements VmTransport {
  /** The isolates this app reports. A second one is what a hot restart leaves behind. */
  isolates: string[] = [ISOLATE];
  requests: any[] = [];
  enabled: string[] = [];
  cleared: string[] = [];
  failEnable = false;
  /** The app's own clock, in microseconds -- what `updatedSince` is expressed in. */
  #now = 1_756_540_800_000_000;
  #updatedAt = new Map<string, number>();
  #onMessage: (text: string) => void = () => {};
  #onClose: () => void = () => {};
  closed = false;

  send(text: string): void {
    const frame = JSON.parse(text);
    const reply = (body: unknown) =>
      queueMicrotask(() => this.#onMessage(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...(body as object) })));

    switch (frame.method) {
      case 'getVM':
        return reply({ result: { isolates: this.isolates.map((id) => ({ id, name: 'main' })) } });
      case 'ext.dart.io.httpEnableTimelineLogging':
        if (this.failEnable) return reply({ error: { code: -32601, message: 'Method not found' } });
        this.enabled.push(frame.params.isolateId);
        return reply({ result: { type: 'HttpTimelineLoggingState', enabled: true } });
      case 'streamListen':
        return reply({ result: { type: 'Success' } });
      case 'ext.dart.io.clearHttpProfile':
        this.cleared.push(frame.params.isolateId);
        this.requests = [];
        this.#updatedAt.clear();
        return reply({ result: { type: 'Success' } });
      case 'ext.dart.io.getHttpProfile': {
        // Faithful to the real extension: only what changed since the caller's
        // last answer, and a fresh server-side timestamp to ask with next time.
        const since = frame.params.updatedSince ?? -1;
        const fresh = this.requests.filter(
          (r) => r.isolateId === frame.params.isolateId && (this.#updatedAt.get(key(r)) ?? 0) > since,
        );
        return reply({ result: { type: 'HttpProfile', timestamp: ++this.#now, requests: fresh } });
      }
      case 'ext.dart.io.getHttpProfileRequest': {
        const found = this.requests.find(
          (r) => r.id === frame.params.id && r.isolateId === frame.params.isolateId,
        );
        if (!found) return reply({ error: { code: 112, message: 'Unknown request id' } });
        return reply({
          result: { ...found, responseBody: [...Buffer.from('{"ok":true}', 'utf8')] },
        });
      }
      default:
        return reply({ error: { code: -32601, message: `no fake for ${frame.method}` } });
    }
  }

  onMessage(cb: (text: string) => void): void { this.#onMessage = cb; }
  onClose(cb: () => void): void { this.#onClose = cb; }
  close(): void { this.closed = true; this.#onClose(); }

  /** Make the app look like it just did an HTTP call. */
  record(id: string, over: Record<string, unknown> = {}, isolateId = ISOLATE): void {
    this.requests.push({
      id, isolateId, method: 'GET', uri: `https://api.mclane360.test/v2/thing/${id}`,
      startTime: 1_756_540_800_000_000, endTime: 1_756_540_800_120_000,
      events: [],
      request: { headers: { accept: ['application/json'] }, contentLength: -1, cookies: [] },
      response: { headers: { 'content-type': ['application/json'] }, statusCode: 200, reasonPhrase: 'OK', contentLength: 11, redirects: [] },
      ...over,
    });
    this.#updatedAt.set(`${isolateId}#${id}`, ++this.#now);
  }
}

/** Request ids are only unique within an isolate, here as in the real profile. */
const key = (request: { isolateId: string; id: string }) => `${request.isolateId}#${request.id}`;

const CONFIG: LaunchConfig = {
  name: 'iOS Simulator (DEV / dev flavor)',
  kind: 'flutter',
  cwd: '/proj/mclane360',
  program: 'lib/main.dart',
  toolArgs: [],
  args: [],
};

let daemon: InstanceType<typeof LaunchDaemon>;
let port: number;
let token: string;

/**
 * The apps the daemon has connected to, in the order it connected to them.
 *
 * One per session, exactly like the real thing: a shared fake would let one
 * session's traffic show up in another's pane, which is precisely the bug this
 * suite is meant to catch.
 */
const vms: FakeVm[] = [];
/** Makes the next app answer `httpEnableTimelineLogging` with -32601, forever. */
let breakNextApp = false;
/** Makes the connection itself fail, the way a dead VM service port does. */
let breakConnect = false;
/** Makes the next app report two isolates, as one that has been hot-restarted does. */
let twoIsolatesNext = false;
/** Every attempt the daemon has made to open a VM service connection. */
let connectAttempts = 0;

/** How long the daemon waits before retrying a failed attach, in this suite. */
const RETRY_BASE_MS = 1000;

before(async () => {
  daemon = new LaunchDaemon('test-network', {
    createClient: async () => {
      connectAttempts++;
      if (breakConnect) throw new Error('connect ECONNREFUSED 127.0.0.1:59175');
      const vm = new FakeVm();
      vm.failEnable = breakNextApp;
      if (twoIsolatesNext) vm.isolates.push(SECOND_ISOLATE);
      vms.push(vm);
      return new VmServiceClient(vm);
    },
    // Fast enough that a test does not wait on a real second.
    networkPollIntervalMs: 20,
    networkRetryBaseMs: RETRY_BASE_MS,
  });
  const handshake = await daemon.listen(0);
  port = handshake.port;
  token = handshake.token;
});

after(async () => {
  // These sessions have a fake child process that will never answer `app.stop`,
  // and `stopAll` waits for that answer. Retire them the way a real exit would.
  for (const session of daemon.registry.list()) {
    (session as { handleExit?: (code: number) => void }).handleExit?.(0);
  }
  await daemon.close();
});

/** Wait until `check()` is true, or fail loudly rather than hanging the suite. */
async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Drive a Flutter session through the real registry, using the recorded lifecycle
 * lines -- `flutter run --machine` output captured from an actual McLane360 run.
 *
 * The registry's flutter branch would need a real device to pick, so the session
 * is adopted directly, which is what `run()` does once a device is chosen.
 */
async function runFlutter(name: string) {
  const session = new FlutterSession({ ...CONFIG, name }, {
    deviceId: 'IPHONE-17-PRO',
    flutter: { command: '/fake/flutter', prefixArgs: [], source: 'fvm-sdk' },
    spawn: () => ({ write: () => {}, kill: () => {} }),
  });
  daemon.registry.adopt(session, CONFIG.cwd);

  session.ingest(line('app.start') + '\n');
  session.ingest(line('app.debugPort') + '\n');
  session.ingest(line('app.started') + '\n');
  return session;
}

/** One `app.log` line in the machine protocol -- the chattiest thing a real app does. */
const logLine = (n: number) =>
  JSON.stringify([{ event: 'app.log', params: { appId: 'app', log: `flutter: frame ${n}` } }]) + '\n';

/** Wait for capture to attach, and hand back the app it attached to. */
async function captured(session: { id: string; snapshot: () => { capabilities: string[] } }) {
  await until(() => session.snapshot().capabilities.includes('network'), 'the network capability');
  return vms[vms.length - 1];
}

test('a Flutter session that publishes a VM service URI gets capture attached, and says so honestly', async () => {
  const session = await runFlutter('capture-me');
  assert.ok(session.vmServiceUri, 'the recorded app.debugPort line must carry a wsUri');
  assert.ok(
    !session.snapshot().capabilities.includes('network'),
    'the capability must not be claimed before the attach has actually succeeded',
  );

  const vm = await captured(session);
  assert.deepEqual(vm.enabled, [ISOLATE]);

  const sessions: any = await daemon.handle({ method: 'sessions' });
  const listed = sessions.find((s: any) => s.id === session.id);
  assert.ok(listed.capabilities.includes('network'), 'the HUD sees it on the next snapshot');
  assert.equal(listed.vmServiceUri, session.vmServiceUri, 'the snapshot carries the URI capture is using');
});

test('captured requests reach the network RPC, filtered and tailed', async () => {
  const session = await runFlutter('rpc');
  const vm = await captured(session);

  vm.record('1');
  vm.record('2', { method: 'POST', uri: 'https://api.mclane360.test/v2/login' });
  await until(
    async () => ((await daemon.handle({ method: 'network', params: { session: session.id } })) as any[]).length >= 2,
    'two captured requests',
  );

  const all: any = await daemon.handle({ method: 'network', params: { session: session.id } });
  assert.deepEqual(all.map((r: any) => r.id), [`${ISOLATE}#1`, `${ISOLATE}#2`]);
  assert.equal(all[0].startTime, 1_756_540_800_000, 'milliseconds all the way out to the client');
  assert.equal(all[0].durationMs, 120);
  assert.equal(all[0].sessionId, session.id);

  const posts: any = await daemon.handle({
    method: 'network', params: { session: session.id, filter: 'post' },
  });
  assert.deepEqual(posts.map((r: any) => r.id), [`${ISOLATE}#2`]);

  const last: any = await daemon.handle({ method: 'network', params: { session: session.id, tail: 1 } });
  assert.equal(last.length, 1);
  assert.equal(last[0].id, `${ISOLATE}#2`);
});

test('networkDetail fetches the full record from the live app, bodies decoded', async () => {
  const session = await runFlutter('detail');
  const vm = await captured(session);
  vm.record('7');
  await until(
    async () => ((await daemon.handle({ method: 'network', params: { session: session.id } })) as any[]).length > 0,
    'a captured request',
  );

  const detail: any = await daemon.handle({
    method: 'networkDetail', params: { session: session.id, id: `${ISOLATE}#7` },
  });
  assert.equal(detail.id, `${ISOLATE}#7`);
  assert.deepEqual(detail.requestHeaders.accept, ['application/json']);
  assert.equal(detail.responseBody.text, '{"ok":true}');
  assert.equal(detail.responseBody.truncated, false);

  await assert.rejects(
    daemon.handle({ method: 'networkDetail', params: { session: session.id, id: `${ISOLATE}#nope` } }),
    /unknown request id/i,
  );
});

test('networkClear empties both the daemon\'s window and the buffer inside the app', async () => {
  const session = await runFlutter('clear');
  const vm = await captured(session);
  vm.record('11');
  await until(
    async () => ((await daemon.handle({ method: 'network', params: { session: session.id } })) as any[]).length > 0,
    'a captured request',
  );

  const result: any = await daemon.handle({ method: 'networkClear', params: { session: session.id } });
  assert.deepEqual(result, { cleared: true });
  const after: any = await daemon.handle({ method: 'network', params: { session: session.id } });
  assert.deepEqual(after, []);
  assert.ok(vm.cleared.includes(ISOLATE), 'the app must free its own buffer too');
});

test('every captured request is pushed over the socket as it happens', async () => {
  const session = await runFlutter('push');
  const vm = await captured(session);

  const socket = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
  const events: any[] = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.event === 'network') events.push(message);
  });
  await new Promise((resolve) => socket.on('open', resolve));

  vm.record('42', { uri: 'https://api.mclane360.test/v2/pushed' });
  await until(() => events.length > 0, 'a pushed network event');

  const pushed = events.find((e) => e.request.id === `${ISOLATE}#42`);
  assert.ok(pushed, 'the HUD learns about a request without polling');
  assert.equal(pushed.sessionId, session.id);
  assert.equal(pushed.request.uri, 'https://api.mclane360.test/v2/pushed');
  socket.close();
});

test('a short request id resolves against what has been captured', async () => {
  const session = await runFlutter('short-id');
  const vm = await captured(session);
  vm.record('7');
  await until(
    async () => ((await daemon.handle({ method: 'network', params: { session: session.id } })) as any[]).length > 0,
    'a captured request',
  );

  // What the CLI's `--detail 7` sends, and what the MCP tool advertises.
  const detail: any = await daemon.handle({
    method: 'networkDetail', params: { session: session.id, id: '7' },
  });
  assert.equal(detail.id, `${ISOLATE}#7`, 'the bare number names the one request that has it');
  assert.equal(detail.responseBody.text, '{"ok":true}');

  await assert.rejects(
    daemon.handle({ method: 'networkDetail', params: { session: session.id, id: '404' } }),
    /no captured request "404"/,
    'an id that was never captured says so, rather than asking the app about it',
  );
});

test('a short id that two isolates both used is refused, not guessed at', async () => {
  // Two isolates is what an app looks like after a hot restart: request numbers
  // start again from 1 in the new one.
  twoIsolatesNext = true;
  let session;
  let vm;
  try {
    session = await runFlutter('ambiguous-id');
    vm = await captured(session);
  } finally {
    twoIsolatesNext = false;
  }
  vm.record('1');
  vm.record('1', {}, SECOND_ISOLATE);
  await until(
    async () => ((await daemon.handle({ method: 'network', params: { session: session.id } })) as any[]).length >= 2,
    'a request from each isolate',
  );

  await assert.rejects(
    daemon.handle({ method: 'networkDetail', params: { session: session.id, id: '1' } }),
    (err: Error) =>
      /matches 2 requests/.test(err.message) &&
      err.message.includes(`${ISOLATE}#1`) &&
      err.message.includes(`${SECOND_ISOLATE}#1`),
    'the refusal has to name the candidates, or it is not actionable',
  );

  // The full id it printed is of course still accepted.
  const detail: any = await daemon.handle({
    method: 'networkDetail', params: { session: session.id, id: `${SECOND_ISOLATE}#1` },
  });
  assert.equal(detail.id, `${SECOND_ISOLATE}#1`);
});

test('an unreachable VM service is complained about once, not once per log line', async () => {
  breakConnect = true;
  const before = connectAttempts;
  try {
    const session = await runFlutter('unreachable');
    await until(() => connectAttempts > before, 'the first connect attempt');

    // A running app talks constantly, and every daemon event emits `change`.
    // Before the backoff existed, each of these bought another connect and
    // another copy of the warning.
    // Spaced out, the way a real app's output arrives: each line lands after the
    // previous failed attach has settled, which is what made this a storm.
    for (let i = 0; i < 40; i++) {
      session.ingest(logLine(i));
      await delay(2);
    }
    await delay(50);

    assert.equal(connectAttempts - before, 1, 'one failed attach must not become forty');
    const warnings = session.recentLogs().filter((l) => l.text.includes('network capture unavailable'));
    assert.equal(warnings.length, 1, 'and the reason is said once, not once per line');
    assert.match(warnings[0].text, /ECONNREFUSED/, 'with the actual reason in it');
  } finally {
    breakConnect = false;
  }
});

test('capture is retried after the backoff, so a slow VM service is not written off', async () => {
  breakConnect = true;
  const before = connectAttempts;
  let session;
  try {
    session = await runFlutter('slow-vm');
    await until(() => connectAttempts > before, 'the first connect attempt');
    assert.equal(connectAttempts - before, 1);
  } finally {
    breakConnect = false;
  }

  // Past the backoff, the next thing the app says gets capture another try --
  // an isolate that was not runnable yet usually is by now.
  await delay(RETRY_BASE_MS + 100);
  session.ingest(logLine(99));
  await until(() => session.snapshot().capabilities.includes('network'), 'the retry to succeed');
  assert.equal(connectAttempts - before, 2, 'exactly one retry, not a flood of them');
});

test('networkDetail on a session that never captured refuses like the rest', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'baton-network-detail-'));
  const session = await daemon.registry.run({
    name: 'plain-detail', kind: 'process', source: 'auto', cwd: scratch,
    command: process.execPath, args: ['-e', 'setTimeout(() => {}, 3000)'],
  } as any);
  try {
    await assert.rejects(
      daemon.handle({ method: 'networkDetail', params: { session: session.id, id: 'isolates/1#1' } }),
      /network capture/i,
    );
  } finally {
    await session.stop();
  }
});

test('a session with no capture refuses the network RPCs with a reason, rather than an empty list', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'baton-network-plain-'));
  const target: any = {
    name: 'plain-process', kind: 'process', source: 'auto', cwd: scratch,
    command: process.execPath, args: ['-e', 'setTimeout(() => {}, 3000)'],
  };
  const session = await daemon.registry.run(target);
  try {
    await assert.rejects(
      daemon.handle({ method: 'network', params: { session: session.id } }),
      /network capture/i,
    );
    await assert.rejects(
      daemon.handle({ method: 'networkClear', params: { session: session.id } }),
      /network capture/i,
    );
  } finally {
    await session.stop();
  }
});

test('stopping a session tears capture down but keeps what it captured readable', async () => {
  const session = await runFlutter('stopper');
  const vm = await captured(session);
  vm.record('99');
  await until(
    async () => ((await daemon.handle({ method: 'network', params: { session: session.id } })) as any[]).length > 0,
    'a captured request',
  );

  session.handleExit(0);
  await until(() => daemon.network.monitor(session.id) === undefined, 'the monitor to be disposed');

  const still: any = await daemon.handle({ method: 'network', params: { session: session.id } });
  assert.equal(still.length, 1, 'the history of a stopped session is still worth reading');

  await assert.rejects(
    daemon.handle({ method: 'networkDetail', params: { session: session.id, id: `${ISOLATE}#99` } }),
    /no longer capturing/i,
  );
});

test('forgetting a session drops its captured traffic with it', async () => {
  const session = await runFlutter('forgettable');
  const vm = await captured(session);
  vm.record('5');
  await until(
    async () => ((await daemon.handle({ method: 'network', params: { session: session.id } })) as any[]).length > 0,
    'a captured request',
  );

  session.handleExit(0);
  const forgotten: any = await daemon.handle({ method: 'forget', params: { session: session.id } });
  assert.equal(forgotten.forgotten, true);
  assert.deepEqual(daemon.network.store.list(session.id), [], 'nothing is left holding the session\'s memory');
});

test('an attach that fails leaves the daemon running and the capability unclaimed', async () => {
  breakNextApp = true;
  try {
    const session = await runFlutter('no-dart-io');
    // Give the attach every chance to succeed, so this is not a race passing by luck.
    await delay(300);
    assert.equal(session.status, 'running', 'a failed attach must not touch the session');
    assert.ok(
      !session.snapshot().capabilities.includes('network'),
      'a capability that would refuse every call must never be advertised',
    );
    await assert.rejects(
      daemon.handle({ method: 'network', params: { session: session.id } }),
      /network capture/i,
    );
    const sessions: any = await daemon.handle({ method: 'sessions' });
    assert.ok(sessions.length > 0, 'the daemon is still answering');

    // The monitor retries a -32601 once after a second before giving up, so the
    // complaint lands a beat after the attach was started.
    await until(
      () => session.recentLogs().some((l) => l.text.includes('network capture unavailable')),
      'the reason to reach the session log, where someone will see it',
    );
    const complaint = session.recentLogs().find((l) => l.text.includes('network capture unavailable'))!;
    assert.ok(complaint.error, 'it is a warning, not ordinary output');
    assert.match(complaint.text, /dart:io extension never registered/);
  } finally {
    breakNextApp = false;
  }
});
