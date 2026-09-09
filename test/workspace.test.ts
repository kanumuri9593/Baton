import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactMark, isLive, liveIds, packSessions, projectTitle, sessionsForRoot,
} from '../src/hud/assets/workspace.js';

test('packSessions keeps a workflow together across project roots', () => {
  const packs = packSessions([
    { id: 'a', name: 'API', root: '/api', workflow: 'Two servers', status: 'running' },
    { id: 'b', name: 'Web', root: '/web', workflow: 'Two servers', status: 'running' },
    { id: 'c', name: 'ios', root: '/app', status: 'running' },
  ]);
  assert.equal(packs.length, 2);
  assert.equal(packs[0].kind, 'workflow');
  assert.equal(packs[0].title, 'Two servers');
  assert.deepEqual(packs[0].sessions.map((s) => s.id), ['a', 'b']);
  assert.equal(packs[1].kind, 'project');
  assert.equal(packs[1].title, 'app');
});

test('liveIds ignores stopped sessions', () => {
  const list = [
    { id: 'live', status: 'running' },
    { id: 'boot', status: 'starting' },
    { id: 'dead', status: 'stopped' },
  ];
  assert.equal(isLive(list[2]), false);
  assert.deepEqual(liveIds(list), ['live', 'boot']);
});

test('sessionsForRoot and projectTitle follow the folder name', () => {
  assert.equal(projectTitle('/Users/me/Desktop/test app'), 'test app');
  const rows = [
    { id: '1', root: '/a' },
    { id: '2', root: '/b' },
  ];
  assert.deepEqual(sessionsForRoot(rows, '/b').map((s) => s.id), ['2']);
});

test('compactMark uses a workspace letter and platform glyphs', () => {
  assert.deepEqual(compactMark({ workflow: 'Two servers' }), { kind: 'workspace', letter: 'T' });
  assert.equal(compactMark({ targets: [{ kind: 'ios' }] }).kind, 'ios');
  assert.equal(compactMark({ targets: [{ kind: 'android' }] }).kind, 'android');
  assert.equal(compactMark({ targets: [{ kind: 'web-dev' }] }).kind, 'web');
  assert.equal(compactMark({ targets: [{ kind: 'flutter' }] }).kind, 'ios');
  assert.equal(compactMark({ targets: [] }).kind, 'folder');
});
