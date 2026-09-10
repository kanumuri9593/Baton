import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactMark, isLive, liveIds, nodeTone, orderedNodes, packSessions, projectTitle, sessionsForRoot,
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

test('packSessions groups by workspace id, and shows the workspace name', () => {
  const packs = packSessions([
    { id: 'a', root: '/api', workflow: 'Delivery', workspace: { id: 'delivery', node: 'api' }, status: 'running' },
    { id: 'b', root: '/web', workflow: 'Delivery', workspace: { id: 'delivery', node: 'console' }, status: 'running' },
  ]);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].id, 'delivery', 'the id is the durable identity');
  assert.equal(packs[0].title, 'Delivery', 'the name is what a person reads');
});

test('two workspaces that happen to share a display name stay apart', () => {
  const packs = packSessions([
    { id: 'a', workflow: 'Delivery', workspace: { id: 'delivery', node: 'api' }, status: 'running' },
    { id: 'b', workflow: 'Delivery', workspace: { id: 'delivery-2', node: 'api' }, status: 'running' },
  ]);
  assert.equal(packs.length, 2);
  assert.deepEqual(packs.map((p) => p.id).sort(), ['delivery', 'delivery-2']);
});

test('a legacy workflow session with no workspace still groups by its name', () => {
  const packs = packSessions([
    { id: 'a', workflow: 'Two servers', status: 'running' },
    { id: 'b', workflow: 'Two servers', status: 'running' },
  ]);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].id, 'Two servers');
});

test('nodeTone maps every engine status, and never invents a success', () => {
  assert.equal(nodeTone('ready'), 'ok');
  assert.equal(nodeTone('starting'), 'busy');
  assert.equal(nodeTone('unhealthy'), 'warn');
  assert.equal(nodeTone('failed'), 'bad');
  assert.equal(nodeTone('external'), 'external', 'not ours is its own thing, not a success');
  for (const idle of ['pending', 'skipped', 'stopped', undefined, 'nonsense']) {
    assert.equal(nodeTone(idle), 'idle');
  }
});

test('orderedNodes reads top to bottom the way the workspace starts', () => {
  const run = {
    nodes: {
      web: { name: 'web', dependsOn: ['api'] },
      db: { name: 'db', dependsOn: [] },
      api: { name: 'api', dependsOn: ['db'] },
    },
  };
  assert.deepEqual(orderedNodes(run).map((n) => n.name), ['db', 'api', 'web']);
  assert.deepEqual(orderedNodes({ nodes: {} }), []);
  assert.deepEqual(orderedNodes({}), []);
});

test('orderedNodes shows every node even if the graph is impossible', () => {
  const cyclic = { nodes: { a: { name: 'a', dependsOn: ['b'] }, b: { name: 'b', dependsOn: ['a'] } } };
  assert.deepEqual(orderedNodes(cyclic).map((n) => n.name).sort(), ['a', 'b']);
});

test('a project with a manifest gets the workspace mark', () => {
  assert.deepEqual(compactMark({ workspace: { name: 'Delivery' }, targets: [{ kind: 'web-dev' }] }), { kind: 'workspace', letter: 'D' });
});
