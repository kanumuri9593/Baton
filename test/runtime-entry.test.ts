import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveRuntimeEntry } from '../src/core/runtime-entry.ts';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function withLayout(files: string[], run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'baton-runtime-entry-'));
  try {
    for (const rel of files) {
      const path = join(root, rel);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '// fixture\n');
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a published layout prefers compiled main.js over leftover main.ts', () => {
  withLayout(['daemon/main.js', 'daemon/main.ts'], (root) => {
    assert.equal(
      resolveRuntimeEntry(join(root, 'daemon'), 'main'),
      join(root, 'daemon', 'main.js'),
    );
  });
});

test('a source checkout falls back to main.ts when JS is not built', () => {
  withLayout(['daemon/main.ts'], (root) => {
    assert.equal(
      resolveRuntimeEntry(join(root, 'daemon'), 'main'),
      join(root, 'daemon', 'main.ts'),
    );
  });
});

test('a production install with only compiled JS uses main.js', () => {
  withLayout(['daemon/main.js'], (root) => {
    assert.equal(
      resolveRuntimeEntry(join(root, 'daemon'), 'main'),
      join(root, 'daemon', 'main.js'),
    );
  });
});

test('missing entries still resolve to the compiled .js path for spawn errors', () => {
  withLayout([], (root) => {
    assert.equal(
      resolveRuntimeEntry(join(root, 'daemon'), 'main'),
      join(root, 'daemon', 'main.js'),
    );
  });
});

test('auto-start resolves the daemon entry at runtime instead of hardcoding main.ts', () => {
  const client = readFileSync(join(srcRoot, 'core', 'client.ts'), 'utf8');
  assert.match(client, /resolveRuntimeEntry/);
  assert.doesNotMatch(client, /['"]main\.ts['"]/);
});
