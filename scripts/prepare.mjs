#!/usr/bin/env node
/**
 * Build compiled output when installing from git.
 *
 * Registry tarballs already contain `dist/`. Git installs do not, and npm
 * typically omits devDependencies on `npm install -g git+https://...`, so this
 * script resolves `typescript` from this package's dependencies rather than
 * hoping `tsc` is on PATH.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiledDaemon = join(root, 'dist', 'daemon', 'main.js');
if (existsSync(compiledDaemon)) process.exit(0);

const require = createRequire(import.meta.url);
let tsc;
try {
  tsc = require.resolve('typescript/bin/tsc');
} catch {
  console.error(
    'baton-run: cannot compile from git because typescript is not installed.\n' +
      'It is a dependency of this package; reinstall without omitting dependencies.',
  );
  process.exit(1);
}

const build = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const copy = spawnSync(process.execPath, [join(root, 'scripts', 'copy-hud-assets.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(copy.status ?? 1);
