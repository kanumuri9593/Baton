#!/usr/bin/env node
/**
 * Rasterise the icon for the places that cannot take an SVG.
 *
 * `assets/baton-app-icon.png` is the production app-icon master. The companion
 * SVG is the crisp, vector-friendly version used by the HUD and README.
 *
 *   node scripts/render-icons.mjs [--sizes 64,512] [--out assets/png]
 *
 * Uses a headless Chromium, which is the one renderer almost every developer
 * machine already has. No image library to install, and it is the same engine
 * that will draw the SVG in the HUD.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Sizes that cover the common targets, largest last so `--sizes` can trim. */
const DEFAULT_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];

const CHROMIUM = {
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
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ],
};

function findChromium() {
  for (const path of CHROMIUM[process.platform] ?? []) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

function parseArgs(argv) {
  const options = { sizes: DEFAULT_SIZES, out: join(ROOT, 'assets', 'png'), icns: process.platform === 'darwin' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sizes') options.sizes = argv[++i].split(',').map(Number).filter(Boolean);
    else if (argv[i] === '--out') options.out = resolve(argv[++i]);
    else if (argv[i] === '--no-icns') options.icns = false;
  }
  return options;
}

/**
 * Rasterise the SVG at `size` and write a PNG.
 *
 * Chromium's `--screenshot` is not usable for this: it clamps the headless
 * window to a few hundred pixels and clamps `--force-device-scale-factor` to
 * 0.5, so anything small silently comes out as a crop of a larger render. A
 * canvas has neither limit. The SVG is inlined as a data URI so the canvas is
 * never tainted and no file access flag is needed, and it is rasterised once at
 * full size then downsampled, which is what keeps a 16px icon legible.
 */
function renderPng(chromium, source, mime, size, outPath, work) {
  const page = join(work, 'render.html');
  const encoded = Buffer.from(source).toString('base64');

  writeFileSync(page, `<!doctype html><meta charset="utf-8"><body>
<script>
const SIZE = ${size}, FULL = 1024;
const image = new Image();
image.onload = () => {
  const full = document.createElement('canvas');
  full.width = full.height = FULL;
  full.getContext('2d').drawImage(image, 0, 0, FULL, FULL);

  const out = document.createElement('canvas');
  out.width = out.height = SIZE;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, SIZE, SIZE);

  document.body.id = out.toDataURL('image/png');
};
image.onerror = () => { document.body.id = 'ERROR'; };
image.src = 'data:${mime};base64,${encoded}';
<\/script></body>`);

  const result = spawnSync(chromium, [
    '--headless=new', '--disable-gpu', '--virtual-time-budget=5000',
    '--dump-dom', `file://${page}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });

  const match = /id="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(result.stdout ?? '');
  if (!match) {
    throw new Error(
      `could not render ${size}px` + (result.error ? `: ${result.error.message}` : ''),
    );
  }
  writeFileSync(outPath, Buffer.from(match[1], 'base64'));
}

/** Bundle a macOS .icns from the sizes Apple's iconutil expects. */
function buildIcns(pngDir, outPath, render) {
  const iconset = join(pngDir, 'baton.iconset');
  mkdirSync(iconset, { recursive: true });
  // Apple wants each size at 1x and 2x; 2x of one size is 1x of the next.
  for (const size of [16, 32, 128, 256, 512]) {
    render(size, join(iconset, `icon_${size}x${size}.png`));
    render(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outPath], { stdio: 'inherit' });
  rmSync(iconset, { recursive: true, force: true });
}

const options = parseArgs(process.argv.slice(2));
const chromium = findChromium();
if (!chromium) {
  console.error(
    'No Chromium-based browser found, and this script uses one as its renderer.\n' +
      'Install Chrome, Edge, Brave or Chromium — or open assets/baton.svg in any\n' +
      'vector editor and export the sizes you need by hand.',
  );
  process.exit(1);
}

const rasterMaster = join(ROOT, 'assets', 'baton-app-icon.png');
const vectorFallback = join(ROOT, 'assets', 'baton.svg');
const tinyGlyph = join(ROOT, 'assets', 'baton-favicon.svg');
const master = existsSync(rasterMaster) ? rasterMaster : vectorFallback;
if (!existsSync(master)) {
  console.error(`missing ${rasterMaster} and ${vectorFallback}`);
  process.exit(1);
}

function sourceFor(size) {
  // Photographic detail is valuable in the Dock but collapses at status-icon
  // sizes. Feed every raster slot artwork designed for its actual pixel size.
  const path = size <= 32 && existsSync(tinyGlyph)
    ? tinyGlyph
    : size <= 64 ? vectorFallback : master;
  return {
    source: readFileSync(path),
    mime: path.endsWith('.png') ? 'image/png' : 'image/svg+xml',
  };
}

const work = join(tmpdir(), `baton-icons-${process.pid}`);
mkdirSync(work, { recursive: true });
mkdirSync(options.out, { recursive: true });

try {
  const render = (size, out) => {
    const selected = sourceFor(size);
    renderPng(chromium, selected.source, selected.mime, size, out, work);
  };
  for (const size of options.sizes) {
    const out = join(options.out, `baton-${size}.png`);
    render(size, out);
    console.log(`  ${size.toString().padStart(4)}px  ${out}`);
  }
  if (options.icns) {
    const icns = join(ROOT, 'assets', 'baton.icns');
    buildIcns(options.out, icns, render);
    console.log(`  icns    ${icns}`);
  }

  // Render the menu bar template icon (Design Concept B, monochrome)
  const menubarSvg = join(ROOT, 'assets', 'baton-menubar.svg');
  if (existsSync(menubarSvg)) {
    const menubarSource = readFileSync(menubarSvg, 'utf8');
    // 18px @1x and 36px @2x for Retina displays
    for (const size of [18, 36]) {
      const out = join(ROOT, 'assets', `baton-menubar-${size}.png`);
      renderPng(chromium, menubarSource, size, out, work);
      console.log(`  ${size.toString().padStart(4)}px  ${out}  (menu bar)`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
