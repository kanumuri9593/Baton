#!/usr/bin/env node
/**
 * Build script for npm distribution.
 * Bundles TypeScript entry points to dist/ with external dependencies preserved.
 * Source files already contain shebangs, so we don't add them in the banner.
 *
 * The build injects BATON_VERSION so bundled code doesn't need to resolve
 * package.json at runtime (path differs between source and dist/).
 */
import { build } from 'esbuild';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const external = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
];

const entryPoints = [
  { entry: 'src/cli/index.ts', outfile: 'dist/cli.js' },
  { entry: 'src/daemon/main.ts', outfile: 'dist/daemon.js' },
  { entry: 'src/mcp/index.ts', outfile: 'dist/mcp.js' },
];

console.log(`Building baton-run@${pkg.version} for npm distribution...`);

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

for (const { entry, outfile } of entryPoints) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    external,
    define: {
      'process.env.BATON_VERSION': JSON.stringify(pkg.version),
    },
  });
  console.log(`  ✓ ${entry} → ${outfile}`);
}

console.log('Build complete.');
