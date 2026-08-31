import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { waitForSession, clampTimeout } = await import('../src/daemon/waiter.ts');
import type { SessionStatus } from '../src/core/types.ts';

/**
 * A minimal stand-in for a real `Session` (which is always a `BaseSession`,
 * i.e. an `EventEmitter`) -- just enough for the waiter to drive: `status`,
 * `snapshot()`, and the events it subscribes to.
 */
class FakeSession extends EventEmitter {
  status: SessionStatus = 'starting';
  url?: string;

  snapshot() {
    return { url: this.url } as any;
  }

  recentLogs() {
    return [];
  }

  setStatus(status: SessionStatus) {
    this.status = status;
    this.emit('change');
  }

  log(text: string) {
    this.emit('log', text, false, Date.now());
  }
}

test('a condition already met resolves immediately, without subscribing any listener', async () => {
  const session = new FakeSession();
  session.status = 'running';

  const result = await waitForSession(session as any, 'running', 1000);

  assert.equal(result.met, true);
  assert.equal(result.status, 'running');
  assert.ok(result.elapsedMs < 100);
  assert.equal(session.listenerCount('change'), 0);
  assert.equal(session.listenerCount('log'), 0);
  assert.equal(session.listenerCount('exit'), 0);
});

test('"running" resolves once a later status change satisfies it, and cleans up its listeners', async () => {
  const session = new FakeSession();
  const pending = waitForSession(session as any, 'running', 2000);

  assert.equal(session.listenerCount('change'), 1, 'must be subscribed while still waiting');
  setTimeout(() => session.setStatus('running'), 10);

  const result = await pending;
  assert.equal(result.met, true);
  assert.equal(result.status, 'running');
  assert.equal(session.listenerCount('change'), 0);
  assert.equal(session.listenerCount('log'), 0);
  assert.equal(session.listenerCount('exit'), 0);
});

test('"url" resolves once the snapshot carries one', async () => {
  const session = new FakeSession();
  session.status = 'running';
  const pending = waitForSession(session as any, 'url', 2000);

  setTimeout(() => {
    session.url = 'http://localhost:5173';
    session.emit('change');
  }, 10);

  const result = await pending;
  assert.equal(result.met, true);
  assert.equal(result.url, 'http://localhost:5173');
});

test('a log condition matches only a NEW line, case-insensitively, and ignores non-matching ones', async () => {
  const session = new FakeSession();
  session.status = 'running';
  // A matching line emitted before the wait started must not count.
  session.log('READY on port 3000');

  const pending = waitForSession(session as any, { log: 'ready on port' }, 2000);

  setTimeout(() => session.log('irrelevant output'), 5);
  setTimeout(() => session.log('Ready on port 3000'), 15);

  const result = await pending;
  assert.equal(result.met, true);
  assert.equal(result.matchedLine, 'Ready on port 3000');
  assert.equal(session.listenerCount('log'), 0);
  assert.equal(session.listenerCount('change'), 0);
});

test('times out with the elapsed status in the message, and removes its listeners', async () => {
  const session = new FakeSession(); // stays 'starting' forever

  await assert.rejects(
    waitForSession(session as any, 'running', 20),
    /timeout after 20ms waiting for running; status is starting/,
  );
  assert.equal(session.listenerCount('change'), 0);
  assert.equal(session.listenerCount('log'), 0);
  assert.equal(session.listenerCount('exit'), 0);
});

test('an impossible condition (failed while waiting for running) throws early, with recent errors attached', async () => {
  const session = new FakeSession();
  const pending = waitForSession(session as any, 'running', 5000, () => ['boom: compile error at line 12']);

  setTimeout(() => session.setStatus('failed'), 10);

  const start = Date.now();
  await assert.rejects(pending, (err: Error) => {
    assert.match(err.message, /session is failed/);
    assert.match(err.message, /boom: compile error at line 12/);
    return true;
  });
  assert.ok(Date.now() - start < 4000, 'must fail immediately, not wait out the 5s timeout');
  assert.equal(session.listenerCount('change'), 0);
  assert.equal(session.listenerCount('log'), 0);
  assert.equal(session.listenerCount('exit'), 0);
});

test('"stopped" is satisfied by either a stopped or a failed status', async () => {
  const stopped = new FakeSession();
  stopped.status = 'stopped';
  assert.equal((await waitForSession(stopped as any, 'stopped', 1000)).status, 'stopped');

  const failed = new FakeSession();
  failed.status = 'failed';
  assert.equal((await waitForSession(failed as any, 'stopped', 1000)).status, 'failed');
});

test('an "exit" event is treated the same as "change" for resolving and for impossibility', async () => {
  const session = new FakeSession();
  const pending = waitForSession(session as any, 'running', 2000);
  setTimeout(() => {
    session.status = 'failed';
    session.emit('exit', 1);
  }, 10);

  await assert.rejects(pending, /session is failed/);
});

test('a malformed until condition is refused rather than silently matching every log line', () => {
  const session = new FakeSession();
  assert.throws(() => waitForSession(session as any, {} as any, 1000), /invalid wait condition/);
  assert.throws(() => waitForSession(session as any, 'bogus' as any, 1000), /invalid wait condition/);
  assert.equal(session.listenerCount('log'), 0);
});

test('clampTimeout applies the default and the cap', () => {
  assert.equal(clampTimeout(undefined), 60_000);
  assert.equal(clampTimeout(1_000_000), 300_000);
  assert.equal(clampTimeout(500), 500);
  assert.equal(clampTimeout(-5), 60_000);
});
