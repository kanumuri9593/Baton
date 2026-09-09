import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseManifest } from '../src/workspace/manifest.ts';
import { validateGraph, topoLevels, dependentsOf, reverseTopo } from '../src/workspace/graph.ts';

const base = resolve('/repo');

/** `deps` is the whole graph: node name -> what it waits for. */
function graph(deps: Record<string, string[]>, exports: Record<string, Record<string, string>> = {}) {
  const nodes: Record<string, unknown> = {};
  for (const [name, dependsOn] of Object.entries(deps)) {
    nodes[name] = { dependsOn, providers: { local: { remote: { url: `http://${name}` } } }, ...(exports[name] ? { exports: exports[name] } : {}) };
  }
  return parseManifest({ name: 'G', nodes }, base);
}

test('a dependency that is not a node names both ends', () => {
  assert.throws(() => validateGraph(graph({ api: ['postgres'] })), /api.*postgres/);
});

test('a node cannot depend on itself', () => {
  assert.throws(() => validateGraph(graph({ api: ['api'] })), /itself/);
});

test('a cycle is reported as the path around it, not just "cycle"', () => {
  assert.throws(
    () => validateGraph(graph({ a: ['c'], b: ['a'], c: ['b'] })),
    /a -> c -> b -> a|b -> a -> c -> b|c -> b -> a -> c/,
  );
});

test('two dependencies exporting the same key would silently overwrite, so it is refused', () => {
  const clash = graph(
    { db: [], cache: [], api: ['db', 'cache'] },
    { db: { URL: '${url}' }, cache: { URL: '${url}' } },
  );
  assert.throws(() => validateGraph(clash), /URL/);
  // The same key on unrelated nodes is fine: nobody merges them.
  assert.doesNotThrow(() => validateGraph(graph({ db: [], cache: [] }, { db: { URL: '${url}' }, cache: { URL: '${url}' } })));
});

test('a valid graph passes and reports nothing', () => {
  assert.doesNotThrow(() => validateGraph(graph({ db: [], api: ['db'], web: ['api'] })));
});

test('topological levels group everything that can start at the same time', () => {
  const manifest = graph({ db: [], queue: [], api: ['db', 'queue'], web: ['api'], mobile: ['api'] });
  const levels = topoLevels(manifest);
  assert.deepEqual(levels.map((l) => [...l].sort()), [['db', 'queue'], ['api'], ['mobile', 'web']]);
});

test('dependents are transitive, so a failure can name everything it took down', () => {
  const manifest = graph({ db: [], api: ['db'], web: ['api'], mobile: ['api'], docs: [] });
  assert.deepEqual(dependentsOf(manifest, 'db').sort(), ['api', 'mobile', 'web']);
  assert.deepEqual(dependentsOf(manifest, 'web'), []);
  assert.deepEqual(dependentsOf(manifest, 'docs'), []);
});

test('shutdown order is the reverse of startup order', () => {
  const manifest = graph({ db: [], api: ['db'], web: ['api'] });
  assert.deepEqual(reverseTopo(manifest), ['web', 'api', 'db']);
});
