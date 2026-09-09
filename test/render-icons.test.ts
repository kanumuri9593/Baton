import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'render-icons.mjs');

function renderPngCallSites(source: string): string[] {
  return [...source.matchAll(/^\s*renderPng\(([^)]+)\);/gm)].map((match) => match[1]);
}

test('renderPng is always called with a mime string and an output path', () => {
  const source = readFileSync(script, 'utf8');
  const definition = source.match(/function renderPng\(([^)]+)\)/);
  assert.ok(definition, 'renderPng must be defined');
  assert.equal(
    definition[1].split(',').map((part) => part.trim()).join(', '),
    'chromium, source, mime, size, outPath, work',
  );

  const calls = renderPngCallSites(source);
  assert.ok(calls.length >= 2, 'app-icon and menu-bar renders must both call renderPng');
  for (const argsRaw of calls) {
    const args = argsRaw.split(',').map((part) => part.trim());
    assert.equal(
      args.length,
      6,
      `renderPng(${argsRaw}) must pass chromium, source, mime, size, outPath, work`,
    );
    assert.notEqual(args[2], 'size', 'the third argument is mime, not the pixel size');
    assert.match(args[2], /mime|image\/|svg/, 'mime must be a string media type');
    assert.match(args[4], /out|Path/, 'the fifth argument must be the PNG path');
  }
});

test('the menu-bar template source ships with the package', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('scripts/render-icons.mjs'));
  assert.ok(pkg.files.includes('assets'));
  assert.ok(existsSync(join(root, 'assets', 'baton-menubar.svg')));
});

test('render-icons writes menu-bar template PNGs without throwing', { skip: !chromiumAvailable() }, () => {
  execFileSync(process.execPath, [script, '--no-icns', '--sizes', '16'], {
    cwd: root,
    stdio: 'pipe',
    timeout: 60_000,
  });
  for (const name of ['baton-menubar-18.png', 'baton-menubar-36.png']) {
    const path = join(root, 'assets', name);
    assert.ok(existsSync(path), `${path} must exist`);
    assert.ok(statSync(path).size > 32, `${path} must be a real PNG`);
    const header = readFileSync(path).subarray(0, 8);
    assert.deepEqual(
      [...header],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${path} must start with a PNG signature`,
    );
  }
});

function chromiumAvailable(): boolean {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ],
  } as const;
  const platform = process.platform as keyof typeof candidates;
  for (const path of candidates[platform] ?? []) {
    if (existsSync(path)) return true;
  }
  return spawnSync('which', ['google-chrome', 'chromium', 'chromium-browser'], {
    encoding: 'utf8',
  }).status === 0;
}
