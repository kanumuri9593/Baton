import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkStore } from '../src/core/network-store.ts';
import type { NetworkRequestSnapshot } from '../src/core/types.ts';

function snapshot(overrides: Partial<NetworkRequestSnapshot> = {}): NetworkRequestSnapshot {
  return {
    id: 'isolates/1#1',
    sessionId: 's1',
    method: 'GET',
    uri: 'https://api.example.test/v2/orders',
    startTime: 1_000,
    endTime: 1_120,
    durationMs: 120,
    statusCode: 200,
    inProgress: false,
    ...overrides,
  };
}

test('a request is stored per session and comes back in arrival order', () => {
  const store = new NetworkStore();
  store.upsert('s1', snapshot({ id: 'a', uri: 'https://x.test/a' }));
  store.upsert('s1', snapshot({ id: 'b', uri: 'https://x.test/b' }));
  store.upsert('s2', snapshot({ id: 'c', uri: 'https://x.test/c' }));

  assert.deepEqual(store.list('s1').map((r) => r.id), ['a', 'b']);
  assert.deepEqual(store.list('s2').map((r) => r.id), ['c']);
  assert.deepEqual(store.list('nobody'), [], 'an unknown session is empty, not an error');
});

test('upserting the same id updates the row in place instead of appending a duplicate', () => {
  const store = new NetworkStore();
  store.upsert('s1', snapshot({ id: 'a', inProgress: true, endTime: undefined, statusCode: undefined }));
  store.upsert('s1', snapshot({ id: 'b' }));
  store.upsert('s1', snapshot({ id: 'a', inProgress: false, statusCode: 204 }));

  const rows = store.list('s1');
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b'], 'the finished request keeps its original position');
  assert.equal(rows[0].statusCode, 204);
  assert.equal(rows[0].inProgress, false);
});

test('the session id on the row is the one it was stored under, whatever the snapshot claimed', () => {
  const store = new NetworkStore();
  store.upsert('real-session', snapshot({ sessionId: '' }));
  assert.equal(store.list('real-session')[0].sessionId, 'real-session');
});

test('every upsert emits, so the daemon can push it to the HUD', () => {
  const store = new NetworkStore();
  const seen: Array<[string, string]> = [];
  store.on('request', (sessionId: string, request: NetworkRequestSnapshot) =>
    seen.push([sessionId, request.id]),
  );
  store.upsert('s1', snapshot({ id: 'a' }));
  store.upsert('s1', snapshot({ id: 'a' }));
  assert.deepEqual(seen, [['s1', 'a'], ['s1', 'a']], 'an update is an event too -- the row changed');
});

test('the oldest rows are evicted past the cap, so a long-running app cannot grow without bound', () => {
  const store = new NetworkStore(500);
  for (let i = 0; i < 600; i++) store.upsert('s1', snapshot({ id: `r${i}` }));

  const rows = store.list('s1', { tail: 1000 });
  assert.equal(rows.length, 500);
  assert.equal(rows[0].id, 'r100', 'the first 100 were evicted');
  assert.equal(rows.at(-1)!.id, 'r599');
});

test('updating an old row does not save it from eviction -- position is arrival, not recency', () => {
  const store = new NetworkStore(3);
  store.upsert('s1', snapshot({ id: 'a' }));
  store.upsert('s1', snapshot({ id: 'b' }));
  store.upsert('s1', snapshot({ id: 'a', statusCode: 500 }));
  store.upsert('s1', snapshot({ id: 'c' }));
  store.upsert('s1', snapshot({ id: 'd' }));

  assert.deepEqual(store.list('s1', { tail: 10 }).map((r) => r.id), ['b', 'c', 'd']);
});

test('tail returns the most recent rows and defaults to 200', () => {
  const store = new NetworkStore();
  for (let i = 0; i < 300; i++) store.upsert('s1', snapshot({ id: `r${i}` }));

  assert.equal(store.list('s1').length, 200);
  assert.equal(store.list('s1').at(-1)!.id, 'r299', 'the newest rows are the ones kept');
  assert.deepEqual(store.list('s1', { tail: 2 }).map((r) => r.id), ['r298', 'r299']);
});

test('filter is a case-insensitive regex over "METHOD uri"', () => {
  const store = new NetworkStore();
  store.upsert('s1', snapshot({ id: 'a', method: 'GET', uri: 'https://api.test/v2/orders' }));
  store.upsert('s1', snapshot({ id: 'b', method: 'POST', uri: 'https://api.test/v2/login' }));
  store.upsert('s1', snapshot({ id: 'c', method: 'GET', uri: 'https://cdn.test/logo.png' }));

  assert.deepEqual(store.list('s1', { filter: 'post' }).map((r) => r.id), ['b']);
  assert.deepEqual(store.list('s1', { filter: '/v2/' }).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(store.list('s1', { filter: '\\.png$' }).map((r) => r.id), ['c']);
  assert.deepEqual(store.list('s1', { filter: 'GET .*orders' }).map((r) => r.id), ['a']);
});

test('an invalid filter regex is an error the caller can see, not a silent empty list', () => {
  const store = new NetworkStore();
  store.upsert('s1', snapshot({ id: 'a' }));
  assert.throws(() => store.list('s1', { filter: '([' }), /filter/i);
});

test('since keeps only requests that started at or after it', () => {
  const store = new NetworkStore();
  store.upsert('s1', snapshot({ id: 'a', startTime: 1000 }));
  store.upsert('s1', snapshot({ id: 'b', startTime: 2000 }));
  store.upsert('s1', snapshot({ id: 'c', startTime: 3000 }));

  assert.deepEqual(store.list('s1', { since: 2000 }).map((r) => r.id), ['b', 'c']);
  assert.deepEqual(store.list('s1', { since: 9999 }), []);
});

test('tail is applied after filtering, so `-n 1 --filter POST` is the last POST', () => {
  const store = new NetworkStore();
  store.upsert('s1', snapshot({ id: 'a', method: 'POST' }));
  store.upsert('s1', snapshot({ id: 'b', method: 'GET' }));
  store.upsert('s1', snapshot({ id: 'c', method: 'POST' }));
  store.upsert('s1', snapshot({ id: 'd', method: 'GET' }));

  assert.deepEqual(store.list('s1', { filter: 'POST', tail: 1 }).map((r) => r.id), ['c']);
});

test('clear empties one session without touching the others, and the session stays known', () => {
  const store = new NetworkStore();
  store.upsert('s1', snapshot({ id: 'a' }));
  store.upsert('s2', snapshot({ id: 'b' }));
  store.clear('s1');

  assert.deepEqual(store.list('s1'), []);
  assert.deepEqual(store.list('s2').map((r) => r.id), ['b']);
  store.upsert('s1', snapshot({ id: 'c' }));
  assert.deepEqual(store.list('s1').map((r) => r.id), ['c'], 'a cleared session still accepts new rows');
});

test('drop forgets the session entirely, which is what `baton forget` needs', () => {
  const store = new NetworkStore();
  store.upsert('s1', snapshot({ id: 'a' }));
  store.upsert('s2', snapshot({ id: 'b' }));
  store.drop('s1');

  assert.deepEqual(store.list('s1'), []);
  assert.deepEqual(store.list('s2').map((r) => r.id), ['b']);
  store.drop('nobody'); // must not throw
});
