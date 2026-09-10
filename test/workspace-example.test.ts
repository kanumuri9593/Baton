import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readManifest, chosenProvider } from '../src/workspace/manifest.ts';
import { validateGraph, topoLevels } from '../src/workspace/graph.ts';
import { detectTargets } from '../src/config/detect.ts';

const LAB = resolve('examples/workflow-lab');

test('the shipped example manifest is valid, and every target it names really exists', () => {
  const { manifest, root } = readManifest(LAB);
  assert.equal(root, LAB);
  assert.doesNotThrow(() => validateGraph(manifest));
  assert.deepEqual(topoLevels(manifest), [['api'], ['console']]);

  for (const [name, node] of Object.entries(manifest.nodes)) {
    const provider = node.providers[chosenProvider(manifest, name)];
    const target = provider.target!;
    const found = detectTargets(target.cwd).map((t) => t.name);
    assert.ok(
      found.includes(target.name),
      `${name} names "${target.name}" in ${target.cwd}, which offers ${found.join(', ')}`,
    );
  }
});

test('the example ships in the published package', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { files: string[] };
  assert.ok(
    pkg.files.includes('examples/workflow-lab/baton.workspace.json'),
    'a manifest nobody installs cannot be the worked example',
  );
});

test('the console reports the port it actually bound, so PORT=0 stays truthful', () => {
  const source = readFileSync(resolve(LAB, 'console/server.mjs'), 'utf8');
  assert.match(source, /server\.address\(\)\.port/);
});
