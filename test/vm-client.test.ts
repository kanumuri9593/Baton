import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VmServiceClient, VmServiceError, type VmTransport } from '../src/vm/vm-client.ts';

/**
 * A scripted stand-in for the VM service's WebSocket.
 *
 * Every frame the client sends is answered from `replies` (method -> result, or
 * a function for per-call answers). `push()` injects an unsolicited frame, which
 * is how `streamNotify` reaches the client in reality.
 */
class FakeTransport implements VmTransport {
  sent: any[] = [];
  closed = false;
  #onMessage: (text: string) => void = () => {};
  #onClose: () => void = () => {};
  replies: Record<string, unknown | ((params: any, id: number) => unknown)>;

  constructor(replies: Record<string, unknown | ((params: any, id: number) => unknown)> = {}) {
    this.replies = replies;
  }

  send(text: string): void {
    const frame = JSON.parse(text);
    this.sent.push(frame);
    const reply = this.replies[frame.method];
    if (reply === undefined) return; // no scripted answer: leave the call pending
    const value = typeof reply === 'function' ? (reply as any)(frame.params, frame.id) : reply;
    // Answer asynchronously, the way a socket would.
    queueMicrotask(() => {
      if (value && typeof value === 'object' && 'error' in (value as any)) {
        this.#onMessage(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: (value as any).error }));
      } else {
        this.#onMessage(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: value }));
      }
    });
  }

  onMessage(cb: (text: string) => void): void { this.#onMessage = cb; }
  onClose(cb: () => void): void { this.#onClose = cb; }
  close(): void { this.closed = true; this.#onClose(); }

  /** Deliver an unsolicited frame, as the VM service does for stream events. */
  push(frame: unknown): void { this.#onMessage(JSON.stringify(frame)); }
}

test('a request is sent as JSON-RPC 2.0 and its reply is matched by id', async () => {
  const transport = new FakeTransport({ getVM: { isolates: [{ id: 'isolates/1', name: 'main' }] } });
  const client = new VmServiceClient(transport);

  const vm = await client.request<{ isolates: { id: string }[] }>('getVM', {});
  assert.deepEqual(vm.isolates, [{ id: 'isolates/1', name: 'main' }]);

  const frame = transport.sent[0];
  assert.equal(frame.jsonrpc, '2.0');
  assert.equal(frame.method, 'getVM');
  assert.equal(typeof frame.id, 'number');
});

test('concurrent requests resolve to their own replies, not whichever answered first', async () => {
  const transport = new FakeTransport({
    // Echo the isolate back so a crossed reply would be obvious.
    'ext.dart.io.getHttpProfile': (params: any) => ({ type: 'HttpProfile', timestamp: 1, requests: [], who: params.isolateId }),
  });
  const client = new VmServiceClient(transport);

  const [a, b] = await Promise.all([
    client.request<any>('ext.dart.io.getHttpProfile', { isolateId: 'isolates/a' }),
    client.request<any>('ext.dart.io.getHttpProfile', { isolateId: 'isolates/b' }),
  ]);
  assert.equal(a.who, 'isolates/a');
  assert.equal(b.who, 'isolates/b');
  assert.notEqual(transport.sent[0].id, transport.sent[1].id, 'ids must be unique per call');
});

test('a JSON-RPC error rejects with both the code and the message', async () => {
  const transport = new FakeTransport({
    'ext.dart.io.httpEnableTimelineLogging': { error: { code: -32601, message: 'method not found' } },
  });
  const client = new VmServiceClient(transport);

  await assert.rejects(
    client.request('ext.dart.io.httpEnableTimelineLogging', { isolateId: 'isolates/1', enabled: true }),
    (err: unknown) => {
      assert.ok(err instanceof VmServiceError);
      assert.equal(err.code, -32601);
      assert.match(err.message, /method not found/);
      return true;
    },
  );
});

test('streamNotify is routed to the handler registered for its stream', async () => {
  const transport = new FakeTransport();
  const client = new VmServiceClient(transport);

  const isolate: any[] = [];
  const other: any[] = [];
  client.onStreamEvent('Isolate', (e) => isolate.push(e));
  client.onStreamEvent('Stdout', (e) => other.push(e));

  transport.push({
    jsonrpc: '2.0',
    method: 'streamNotify',
    params: { streamId: 'Isolate', event: { kind: 'IsolateRunnable', isolate: { id: 'isolates/2' } } },
  });

  assert.equal(isolate.length, 1);
  assert.equal(isolate[0].kind, 'IsolateRunnable');
  assert.equal(isolate[0].isolate.id, 'isolates/2');
  assert.equal(other.length, 0, 'a different stream must not receive it');
});

test('several handlers on one stream all fire, and a throwing one does not stop the rest', () => {
  const transport = new FakeTransport();
  const client = new VmServiceClient(transport);
  const seen: string[] = [];
  client.onStreamEvent('Isolate', () => { throw new Error('boom'); });
  client.onStreamEvent('Isolate', () => seen.push('second'));

  transport.push({
    jsonrpc: '2.0', method: 'streamNotify',
    params: { streamId: 'Isolate', event: { kind: 'IsolateExit', isolate: { id: 'isolates/1' } } },
  });
  assert.deepEqual(seen, ['second']);
});

test('streamListen tolerates error 103 -- already subscribed is not a failure', async () => {
  const transport = new FakeTransport({
    streamListen: { error: { code: 103, message: 'Stream already subscribed' } },
  });
  const client = new VmServiceClient(transport);
  await client.streamListen('Isolate'); // must not reject
  assert.equal(transport.sent[0].params.streamId, 'Isolate');
});

test('streamListen still propagates an error that is not 103', async () => {
  const transport = new FakeTransport({
    streamListen: { error: { code: 100, message: 'Feature is disabled' } },
  });
  const client = new VmServiceClient(transport);
  await assert.rejects(client.streamListen('Isolate'), /Feature is disabled/);
});

test('a call the VM service accepts but never answers gives up on its own', async () => {
  // The nastiest failure mode: the socket is open, so nothing looks wrong, and
  // without a timeout the caller waits forever -- in the daemon that meant an
  // attach stuck in flight, blocking every later retry, with nothing logged.
  const transport = new FakeTransport(); // nothing is ever answered
  const client = new VmServiceClient(transport, { requestTimeoutMs: 20 });

  // The method has to be in the message: "something timed out" is not a bug report.
  await assert.rejects(client.request('getVM', {}), /did not answer getVM within 20ms/);

  // The abandoned call must be forgotten, not left to reject a second time.
  client.close();
  await assert.rejects(client.request('getVM', {}), /closed/i);
});

test('a request answered in time is unaffected by the timeout', async () => {
  const transport = new FakeTransport({ getVM: { isolates: [] } });
  const client = new VmServiceClient(transport, { requestTimeoutMs: 5000 });
  assert.deepEqual(await client.request('getVM', {}), { isolates: [] });
  client.close();
});

test('close rejects every pending request instead of leaving them hanging forever', async () => {
  const transport = new FakeTransport(); // nothing is ever answered
  const client = new VmServiceClient(transport);
  const pending = client.request('getVM', {});
  client.close();
  await assert.rejects(pending, /closed/i);
  assert.equal(transport.closed, true, 'closing the client must close its transport');
});

test('the transport closing under us rejects pending requests the same way', async () => {
  const transport = new FakeTransport();
  const client = new VmServiceClient(transport);
  const pending = client.request('getVM', {});
  transport.close(); // e.g. the app was killed
  await assert.rejects(pending, /closed/i);
});

test('a request made after close is rejected rather than silently dropped', async () => {
  const transport = new FakeTransport({ getVM: { isolates: [] } });
  const client = new VmServiceClient(transport);
  client.close();
  await assert.rejects(client.request('getVM', {}), /closed/i);
});

test('a malformed or unknown frame is ignored rather than crashing the client', async () => {
  const transport = new FakeTransport({ getVM: { isolates: [] } });
  const client = new VmServiceClient(transport);
  transport.push('not-an-object');
  // A reply for an id nobody is waiting on must also be harmless.
  transport.push({ jsonrpc: '2.0', id: 9999, result: {} });
  assert.deepEqual((await client.request<any>('getVM', {})).isolates, []);
});
