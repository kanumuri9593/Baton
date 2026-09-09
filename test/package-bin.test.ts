import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
};

test('npm bin entries use JS shims so registry publish keeps the commands', () => {
  const bins = pkg.bin;
  assert.ok(bins.baton && bins['baton-daemon'] && bins['baton-mcp']);
  for (const [name, rel] of Object.entries(bins)) {
    assert.match(rel, /\.(js|mjs|cjs)$/, `${name} must not be a .ts path; npm strips those on publish`);
    const abs = join(root, rel);
    assert.equal(existsSync(abs), true, `${rel} is missing`);
    const text = readFileSync(abs, 'utf8');
    assert.match(text, /^#!/);
  }
});

test('the baton shim prints usage', () => {
  const out = execFileSync(process.execPath, [join(root, pkg.bin.baton)], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.match(out, /baton —/);
});

test('the published build contains every control-panel asset', () => {
  const source = join(root, 'src', 'hud', 'assets');
  const built = join(root, 'dist', 'hud', 'assets');
  for (const name of ['index.html', 'hud.css', 'icons.js', 'core.js', 'settings.js',
    'filters.js', 'diagnostics.js', 'network.js', 'editor.js', 'inspector.js']) {
    assert.equal(existsSync(join(source, name)), true, `source asset ${name} is missing`);
    assert.equal(existsSync(join(built, name)), true, `published asset ${name} is missing`);
  }
});
