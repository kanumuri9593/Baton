import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the daemon's state out of the real ~/.clilaunch.
process.env.CLILAUNCH_HOME = mkdtempSync(join(tmpdir(), 'clilaunch-server-'));

const { LaunchDaemon, matchTarget } = await import('../src/daemon/server.ts');

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
  assert.match(hud, /<title>CLI-Launch<\/title>/);
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
    /clilaunch list/,
  );
});

test('matchTarget prefers an exact name over a substring', () => {
  const targets = [{ name: 'dev' }, { name: 'dev:web' }];
  assert.equal(matchTarget(targets, 'dev')!.name, 'dev');
  assert.equal(matchTarget(targets, 'web')!.name, 'dev:web');
  assert.equal(matchTarget(targets, ''), undefined);
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
