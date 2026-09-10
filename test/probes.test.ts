import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import {
  probeOnce, pollProbe, describeProbe, isProbe, ProbeAborted, type NetProbe,
} from '../src/daemon/probes.ts';

/** A TCP listener on an ephemeral port, plus the closer for it. */
async function listener(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }) };
}

async function httpListener(status: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((_req, res) => { res.statusCode = status; res.end('ok'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/health`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** A port that is definitely free: bind one, learn its number, release it. */
async function freePort(): Promise<number> {
  const { port, close } = await listener();
  await close();
  return port;
}

test('isProbe accepts the two address-based shapes and nothing else', () => {
  assert.ok(isProbe({ tcp: 5432 }));
  assert.ok(isProbe({ http: 'http://x/health' }));
  assert.ok(isProbe({ http: 'http://x/health', status: 204 }));
  for (const not of [{ log: 'ready' }, 'running', null, {}, { tcp: 0 }, { tcp: 70000 }, { tcp: 1.5 }, { http: '' }]) {
    assert.equal(isProbe(not), false, `${JSON.stringify(not)} is not a probe`);
  }
});

test('describeProbe reads the way it would in an error message', () => {
  assert.equal(describeProbe({ tcp: 5432 }), 'tcp:5432');
  assert.equal(describeProbe({ http: 'http://x/health' }), 'http:http://x/health');
  assert.equal(describeProbe({ http: 'http://x/health', status: 204 }), 'http:http://x/health (204)');
});

test('a TCP probe answers for a listening port and reports the refusal for a closed one', async () => {
  const server = await listener();
  assert.deepEqual(await probeOnce({ tcp: server.port }), { ok: true });
  await server.close();

  const closed = await probeOnce({ tcp: server.port }, 500);
  assert.equal(closed.ok, false);
  assert.match(String(closed.detail), /ECONNREFUSED/);
});

test('an HTTP probe counts any answer as up unless a status was demanded', async () => {
  const server = await httpListener(404);
  assert.equal((await probeOnce({ http: server.url })).ok, true, 'a 404 still proves it is listening');

  const wrong = await probeOnce({ http: server.url, status: 200 });
  assert.equal(wrong.ok, false);
  assert.match(String(wrong.detail), /HTTP 404, expected 200/);

  assert.equal((await probeOnce({ http: server.url, status: 404 })).ok, true);
  await server.close();

  const gone = await probeOnce({ http: server.url }, 500);
  assert.equal(gone.ok, false);
  // The exact cause depends on whether a keep-alive socket was reused, but it
  // must always be the transport error rather than a claim that the node is up.
  assert.match(String(gone.detail), /ECONN|fetch failed/);
});

test('polling succeeds as soon as the service comes up mid-poll', async () => {
  const port = await freePort();
  let server: Awaited<ReturnType<typeof listener>> | undefined;
  const late = setTimeout(async () => {
    const started = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => started.listen(port, '127.0.0.1', resolve));
    server = { port, close: () => new Promise<void>((r) => { started.close(() => r()); }) };
  }, 60);
  late.unref();

  const result = await pollProbe({ tcp: port }, { timeoutMs: 5000, intervalMs: 20 });
  assert.equal(result.ok, true);
  await server?.close();
});

test('a timeout names the probe and the last thing it actually saw', async () => {
  const port = await freePort();
  await assert.rejects(
    pollProbe({ tcp: port }, { timeoutMs: 120, intervalMs: 20 }),
    (error: Error) => {
      assert.match(error.message, new RegExp(`tcp:${port} never answered within 120ms`));
      assert.match(error.message, /last: ECONNREFUSED/);
      return true;
    },
  );
});

test('aborting stops the poll promptly instead of waiting out the timeout', async () => {
  const controller = new AbortController();
  const port = await freePort();
  const started = Date.now();
  const pending = pollProbe({ tcp: port }, { timeoutMs: 10_000, intervalMs: 50, signal: controller.signal });
  setTimeout(() => controller.abort(), 30).unref();

  await assert.rejects(pending, (error: Error) => {
    assert.ok(error instanceof ProbeAborted);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, 'abort must not wait out the timeout');
});

test('an injected probe function lets callers drive readiness without a network', async () => {
  const seen: NetProbe[] = [];
  let attempts = 0;
  const result = await pollProbe({ http: 'http://x/health' }, {
    intervalMs: 1,
    probeFn: async (probe) => {
      seen.push(probe);
      attempts += 1;
      return attempts < 3 ? { ok: false, detail: 'ECONNREFUSED' } : { ok: true, detail: 'HTTP 200' };
    },
  });
  assert.equal(result.detail, 'HTTP 200');
  assert.equal(attempts, 3);
  assert.deepEqual(seen[0], { http: 'http://x/health' });
});
