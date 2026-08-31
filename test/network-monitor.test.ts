import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VmServiceClient, type VmTransport } from '../src/vm/vm-client.ts';
import { NetworkMonitor, decodeBody, normalizeDetail } from '../src/vm/network-monitor.ts';
import type { NetworkRequestSnapshot } from '../src/core/types.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'vm-http-profile.txt');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Exchange = { request: any; response: any; used: boolean };

/**
 * Replays `fixtures/vm-http-profile.txt`.
 *
 * A frame the client sends is matched against the transcript's `>` lines by
 * method AND params -- so a client that forgets to echo `updatedSince`, or
 * skips the -32601 retry, finds no scripted answer and its call hangs, which
 * fails the test rather than passing by accident.
 */
class ReplayTransport implements VmTransport {
  exchanges: Exchange[] = [];
  pushes: any[] = [];
  unexpected: any[] = [];
  closed = false;
  #onMessage: (text: string) => void = () => {};
  #onClose: () => void = () => {};

  constructor(path = FIXTURE) {
    let lastRequest: any;
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const frame = JSON.parse(line.slice(2));
      if (line[0] === '>') lastRequest = frame;
      else if (line[0] === '<') this.exchanges.push({ request: lastRequest, response: frame, used: false });
      else if (line[0] === '!') this.pushes.push(frame);
    }
  }

  send(text: string): void {
    const sent = JSON.parse(text);
    const match = this.exchanges.find(
      (e) =>
        !e.used &&
        e.request.method === sent.method &&
        JSON.stringify(e.request.params ?? {}) === JSON.stringify(sent.params ?? {}),
    );
    if (!match) { this.unexpected.push(sent); return; }
    match.used = true;
    // The transcript's ids are illustrative; the reply belongs to whatever id
    // this client actually allocated.
    queueMicrotask(() => this.#onMessage(JSON.stringify({ ...match.response, id: sent.id })));
  }

  onMessage(cb: (text: string) => void): void { this.#onMessage = cb; }
  onClose(cb: () => void): void { this.#onClose = cb; }
  close(): void { this.closed = true; this.#onClose(); }

  /** Deliver the transcript's unsolicited `!` frames -- the hot-restart isolate churn. */
  pushAll(): void { for (const frame of this.pushes) this.#onMessage(JSON.stringify(frame)); }
}

/** Attach a monitor to the transcript, with the poll timer effectively disabled. */
async function replay() {
  const transport = new ReplayTransport();
  const client = new VmServiceClient(transport);
  const monitor = new NetworkMonitor(client, {
    sessionId: 'mclane360/ios@48F0A0D1',
    pollIntervalMs: 3_600_000, // never fires on its own; tests call pollOnce()
    retryDelayMs: 0,
  });
  const seen: NetworkRequestSnapshot[] = [];
  monitor.on('request', (snapshot: NetworkRequestSnapshot) => seen.push(snapshot));
  await monitor.attach();
  return { transport, client, monitor, seen };
}

const MAIN = 'isolates/1963006521159535';
const RESTARTED = 'isolates/7215544120983311';

test('attach enables the isolate, retrying once past the -32601 the extension answers before it registers', async () => {
  const { monitor, transport } = await replay();
  assert.deepEqual([...monitor.isolates], [MAIN]);
  const enables = transport.exchanges.filter(
    (e) => e.request.method === 'ext.dart.io.httpEnableTimelineLogging' && e.used,
  );
  assert.equal(enables.length, 2, 'the -32601 must be retried exactly once, not given up on');
  assert.ok(
    transport.exchanges.some((e) => e.request.method === 'streamListen' && e.used),
    'Isolate stream must be subscribed so a hot restart is noticed',
  );
  assert.deepEqual(transport.unexpected, []);
  monitor.dispose();
});

test('a poll normalizes microseconds to milliseconds and reports what each request did', async () => {
  const { monitor, seen } = await replay();
  await monitor.pollOnce();
  assert.equal(seen.length, 3);

  const [orders, login, logo] = seen;

  assert.equal(orders.id, `${MAIN}#1`, 'ids are isolate-scoped so two isolates cannot collide');
  assert.equal(orders.sessionId, 'mclane360/ios@48F0A0D1');
  assert.equal(orders.method, 'GET');
  assert.equal(orders.uri, 'https://api.mclane360.test/v2/orders?page=1');
  assert.equal(orders.startTime, 1756540800000, 'microseconds since the epoch become milliseconds');
  assert.equal(orders.endTime, 1756540800187);
  assert.equal(orders.durationMs, 187);
  assert.equal(orders.statusCode, 200);
  assert.equal(orders.reasonPhrase, 'OK');
  assert.equal(orders.contentType, 'application/json; charset=utf-8');
  assert.equal(orders.responseContentLength, 23);
  assert.equal(orders.requestContentLength, undefined, 'dart:io reports -1 for "unknown", not a real length');
  assert.equal(orders.inProgress, false);
  assert.equal(orders.error, undefined);

  assert.equal(login.statusCode, 401);
  assert.equal(login.requestContentLength, 35);
  assert.equal(login.durationMs, 444);

  assert.equal(logo.inProgress, true, 'no endTime yet means still in flight');
  assert.equal(logo.endTime, undefined);
  assert.equal(logo.durationMs, undefined);
  assert.equal(logo.statusCode, undefined);
  monitor.dispose();
});

test('the second poll echoes the server timestamp as updatedSince, avoiding clock skew', async () => {
  const { monitor, transport, seen } = await replay();
  await monitor.pollOnce();
  await monitor.pollOnce();
  assert.deepEqual(transport.unexpected, [], 'poll 2 must send updatedSince: 1756540800500000');
  const second = transport.exchanges.find(
    (e) => e.request.method === 'ext.dart.io.getHttpProfile' && e.request.params.updatedSince,
  );
  assert.ok(second?.used);
  assert.equal(second!.request.params.updatedSince, 1756540800500000);
  assert.equal(seen.length, 5, 'poll 2 re-delivers the updated in-flight request plus one new one');
  monitor.dispose();
});

test('an in-flight request finishing keeps its id, so it is an update rather than a second row', async () => {
  const { monitor, seen } = await replay();
  await monitor.pollOnce();
  await monitor.pollOnce();

  const forLogo = seen.filter((s) => s.id === `${MAIN}#3`);
  assert.equal(forLogo.length, 2, 'the same request was delivered twice, under one id');
  assert.equal(forLogo[0].inProgress, true);
  assert.equal(forLogo[1].inProgress, false);
  assert.equal(forLogo[1].durationMs, 850);
  assert.equal(forLogo[1].statusCode, 200);
  assert.equal(forLogo[1].contentType, 'image/png');
  monitor.dispose();
});

test('a transport-level failure surfaces as an error on the request, with no status code', async () => {
  const { monitor, seen } = await replay();
  await monitor.pollOnce();
  await monitor.pollOnce();

  const failed = seen.find((s) => s.id === `${MAIN}#4`)!;
  assert.match(failed.error!, /Connection refused/);
  assert.equal(failed.statusCode, undefined);
  assert.equal(failed.inProgress, false, 'it ended -- badly, but it ended');
  monitor.dispose();
});

test('a hot restart re-enables capture on the fresh isolate and forgets the dead one', async () => {
  const { monitor, transport, seen } = await replay();
  await monitor.pollOnce();
  await monitor.pollOnce();

  transport.pushAll(); // IsolateExit(old), IsolateStart(new), IsolateRunnable(new)
  await delay(10);

  assert.deepEqual([...monitor.isolates], [RESTARTED], 'the dead isolate must be dropped, the new one enabled');

  await monitor.pollOnce();
  assert.deepEqual(transport.unexpected, [], 'the new isolate is polled from scratch, with no stale updatedSince');
  const fresh = seen.at(-1)!;
  assert.equal(fresh.id, `${RESTARTED}#1`);
  assert.equal(fresh.uri, 'https://api.mclane360.test/v2/config');
  assert.equal(fresh.statusCode, 204);
  monitor.dispose();
});

test('fetchDetail plus normalizeDetail decodes a UTF-8 body and keeps the headers as lists', async () => {
  const { monitor } = await replay();
  const raw = await monitor.fetchDetail(MAIN, '2');
  const detail = normalizeDetail('s1', MAIN, raw);

  assert.equal(detail.id, `${MAIN}#2`);
  assert.equal(detail.method, 'POST');
  assert.equal(detail.statusCode, 401);
  assert.deepEqual(detail.requestHeaders['content-type'], ['application/json']);
  assert.deepEqual(detail.responseHeaders!['content-type'], ['application/json']);
  assert.equal(detail.requestBody!.text, '{"user":"ops","password":"hunter2"}');
  assert.equal(detail.requestBody!.size, 35);
  assert.equal(detail.requestBody!.truncated, false);
  assert.equal(
    Buffer.from(detail.requestBody!.base64, 'base64').toString('utf8'),
    '{"user":"ops","password":"hunter2"}',
    'base64 is always present, so a client can reconstruct the exact bytes',
  );
  assert.equal(detail.responseBody!.text, '{"error":"invalid credentials"}');
  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0].timestamp, 1756540800201, 'event timestamps are milliseconds too');
  monitor.dispose();
});

test('a binary body comes back as base64 with no text, rather than mojibake', async () => {
  const { monitor } = await replay();
  const raw = await monitor.fetchDetail(MAIN, '3');
  const detail = normalizeDetail('s1', MAIN, raw);

  assert.equal(detail.responseBody!.text, undefined, 'PNG bytes are not valid UTF-8');
  assert.equal(detail.responseBody!.size, 9);
  assert.deepEqual(
    [...Buffer.from(detail.responseBody!.base64, 'base64')],
    [137, 80, 78, 71, 13, 10, 26, 10, 0],
  );
  assert.equal(detail.requestBody, undefined, 'a GET with no body has no requestBody at all');
  monitor.dispose();
});

test('a single-value header sent as a bare string is normalized to a list', async () => {
  const { monitor, seen } = await replay();
  await monitor.pollOnce();
  await monitor.pollOnce();
  // The transcript sends the logo response's content-length as "9", not ["9"].
  const raw = await monitor.fetchDetail(MAIN, '3');
  const detail = normalizeDetail('s1', MAIN, {
    ...raw,
    response: { ...raw.response, headers: { ...raw.response.headers, 'content-length': '9' } },
  });
  assert.deepEqual(detail.responseHeaders!['content-length'], ['9']);
  assert.ok(seen.length > 0);
  monitor.dispose();
});

// --- body decoding, in isolation --------------------------------------------

test('decodeBody caps at maxBody and says so, keeping the real size', () => {
  const bytes = Array.from({ length: 300 }, () => 0x61); // 300 x "a"
  const body = decodeBody(bytes, 100)!;
  assert.equal(body.size, 300, 'size is the real size, not the capped one');
  assert.equal(body.truncated, true);
  assert.equal(body.text, 'a'.repeat(100));
  assert.equal(Buffer.from(body.base64, 'base64').length, 100, 'base64 carries only the capped prefix');
});

test('decodeBody still previews text when the cap lands mid-character', () => {
  // "€" is three bytes; cutting at 4 leaves one whole "a" plus a dangling pair.
  const bytes = [...Buffer.from('a€€', 'utf8')];
  const body = decodeBody(bytes, 4)!;
  assert.equal(body.truncated, true);
  assert.equal(body.text, 'a€', 'the incomplete trailing character is dropped, not the whole preview');
});

test('decodeBody returns nothing at all for an absent body', () => {
  assert.equal(decodeBody(undefined), undefined);
  assert.deepEqual(decodeBody([]), { base64: '', text: '', size: 0, truncated: false });
});

// --- failure paths ----------------------------------------------------------

/** A transport that answers from a fixed script, for the paths the transcript does not cover. */
class ScriptedTransport implements VmTransport {
  replies: Record<string, (params: any) => unknown>;
  #onMessage: (text: string) => void = () => {};
  #onClose: () => void = () => {};
  closed = false;

  constructor(replies: Record<string, (params: any) => unknown>) { this.replies = replies; }

  send(text: string): void {
    const frame = JSON.parse(text);
    const reply = this.replies[frame.method];
    if (!reply) return;
    const value = reply(frame.params);
    queueMicrotask(() => {
      const body = value && typeof value === 'object' && 'error' in (value as any)
        ? { error: (value as any).error }
        : { result: value };
      this.#onMessage(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...body }));
    });
  }

  onMessage(cb: (text: string) => void): void { this.#onMessage = cb; }
  onClose(cb: () => void): void { this.#onClose = cb; }
  close(): void { this.closed = true; this.#onClose(); }

  /** Deliver one unsolicited frame, the way the Isolate stream does. */
  push(frame: unknown): void { this.#onMessage(JSON.stringify(frame)); }
}

/** An `IsolateExit` for one isolate, as it arrives on the Isolate stream. */
const isolateExit = (id: string) => ({
  jsonrpc: '2.0',
  method: 'streamNotify',
  params: { streamId: 'Isolate', event: { type: 'Event', kind: 'IsolateExit', isolate: { id } } },
});

test('an app with no isolates left is let go, but not before a restart could replace them', async () => {
  const transport = new ScriptedTransport({
    getVM: () => ({ isolates: [{ id: 'isolates/1' }] }),
    'ext.dart.io.httpEnableTimelineLogging': () => ({ type: 'HttpTimelineLoggingState', enabled: true }),
    streamListen: () => ({ type: 'Success' }),
    'ext.dart.io.getHttpProfile': () => ({ type: 'HttpProfile', timestamp: 1, requests: [] }),
  });
  const monitor = new NetworkMonitor(new VmServiceClient(transport), {
    pollIntervalMs: 3_600_000, retryDelayMs: 0,
  });
  let detached = 0;
  monitor.on('detached', () => detached++);
  await monitor.attach();

  transport.push(isolateExit('isolates/1'));
  assert.deepEqual(monitor.isolates, [], 'the exited isolate is dropped');

  // A hot restart is a beat with nothing to poll, and the new isolate may need
  // a moment (plus a -32601 retry) before it accepts capture. Detaching then
  // would kill capture for the rest of the run.
  for (let i = 0; i < 9; i++) await monitor.pollOnce();
  assert.equal(detached, 0, 'a short gap with no isolate is a restart, not a death');

  await monitor.pollOnce();
  assert.equal(detached, 1, 'ten rounds with nothing to poll means the app is gone');

  await monitor.pollOnce();
  assert.equal(detached, 1, 'and it is said once, with polling stopped');
  monitor.dispose();
});

test('attach fails when no isolate accepts capture, so no capability is ever claimed', async () => {
  const transport = new ScriptedTransport({
    getVM: () => ({ isolates: [{ id: 'isolates/1' }] }),
    'ext.dart.io.httpEnableTimelineLogging': () => ({ error: { code: -32601, message: 'Method not found' } }),
    streamListen: () => ({ type: 'Success' }),
  });
  const monitor = new NetworkMonitor(new VmServiceClient(transport), { retryDelayMs: 0 });
  await assert.rejects(monitor.attach(), /http.*capture|timeline|isolate/i);
  assert.equal(monitor.isolates.length, 0);
  monitor.dispose();
});

test('attach fails when the VM reports no isolates at all', async () => {
  const transport = new ScriptedTransport({
    getVM: () => ({ isolates: [] }),
    streamListen: () => ({ type: 'Success' }),
  });
  const monitor = new NetworkMonitor(new VmServiceClient(transport), { retryDelayMs: 0 });
  await assert.rejects(monitor.attach());
  monitor.dispose();
});

test('three consecutive failed polls detach; a transient one does not', async () => {
  let failing = true;
  const transport = new ScriptedTransport({
    getVM: () => ({ isolates: [{ id: 'isolates/1' }] }),
    'ext.dart.io.httpEnableTimelineLogging': () => ({ type: 'HttpTimelineLoggingState', enabled: true }),
    streamListen: () => ({ type: 'Success' }),
    'ext.dart.io.getHttpProfile': () =>
      failing
        ? { error: { code: 106, message: 'Isolate must be runnable' } }
        : { type: 'HttpProfile', timestamp: 42, requests: [] },
  });
  const monitor = new NetworkMonitor(new VmServiceClient(transport), {
    pollIntervalMs: 3_600_000, retryDelayMs: 0,
  });
  let detached = 0;
  monitor.on('detached', () => detached++);
  await monitor.attach();

  await monitor.pollOnce();
  await monitor.pollOnce();
  assert.equal(detached, 0, 'two failures are transient -- an app can be mid-restart');

  failing = false;
  await monitor.pollOnce();
  assert.equal(detached, 0);

  failing = true;
  await monitor.pollOnce();
  await monitor.pollOnce();
  assert.equal(detached, 0, 'the successful poll must have reset the streak');
  await monitor.pollOnce();
  assert.equal(detached, 1, 'three in a row means the app is gone');

  await monitor.pollOnce();
  assert.equal(detached, 1, 'detaching happens once, and stops the polling');
  monitor.dispose();
});

test('clear frees the profile buffer inside the app, for every enabled isolate', async () => {
  const cleared: string[] = [];
  const transport = new ScriptedTransport({
    getVM: () => ({ isolates: [{ id: 'isolates/1' }] }),
    'ext.dart.io.httpEnableTimelineLogging': () => ({ type: 'HttpTimelineLoggingState', enabled: true }),
    streamListen: () => ({ type: 'Success' }),
    'ext.dart.io.clearHttpProfile': (params: any) => { cleared.push(params.isolateId); return { type: 'Success' }; },
  });
  const monitor = new NetworkMonitor(new VmServiceClient(transport), { retryDelayMs: 0 });
  await monitor.attach();
  await monitor.clear();
  assert.deepEqual(cleared, ['isolates/1']);
  monitor.dispose();
});

test('dispose closes the connection and stops polling', async () => {
  const transport = new ScriptedTransport({
    getVM: () => ({ isolates: [{ id: 'isolates/1' }] }),
    'ext.dart.io.httpEnableTimelineLogging': () => ({ type: 'HttpTimelineLoggingState', enabled: true }),
    streamListen: () => ({ type: 'Success' }),
  });
  const monitor = new NetworkMonitor(new VmServiceClient(transport), { retryDelayMs: 0 });
  await monitor.attach();
  monitor.dispose();
  assert.equal(transport.closed, true);
  await monitor.pollOnce(); // must be a harmless no-op, not a throw
});
