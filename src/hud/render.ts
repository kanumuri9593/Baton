import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * The brand assets, read once from `assets/`.
 *
 * Read rather than duplicated, so the page, the README and the app icon can
 * never drift apart. A missing file degrades to no icon instead of a 500.
 */
function asset(name: string): string {
  try {
    return readFileSync(join(dirname(import.meta.dirname), '..', 'assets', name), 'utf8').trim();
  } catch {
    return '';
  }
}

const TILE = asset('baton.svg');
const MARK = asset('baton-mark.svg');
/** Second copy of the mark for the chip — SVG ids must be unique on the page. */
const CHIP_MARK = MARK
  .replaceAll('id="sweep"', 'id="chip-sweep"')
  .replaceAll('url(#sweep)', 'url(#chip-sweep)');
const FAVICON = TILE
  ? `data:image/svg+xml;base64,${Buffer.from(TILE).toString('base64')}`
  : '';

/**
 * The HUD's own static assets: the page shell, its stylesheet and its scripts.
 *
 * Kept as a Map from request-facing name to absolute path (rather than joining
 * the request path onto a directory) so the daemon's asset route can never be
 * tricked into serving an arbitrary file -- an unknown name is simply absent
 * from the map, whatever characters it contains.
 */
export const HUD_ASSET_DIR = join(import.meta.dirname, 'assets');

export const HUD_ASSETS: ReadonlyMap<string, { path: string; contentType: string }> = new Map([
  ['hud.css', { path: join(HUD_ASSET_DIR, 'hud.css'), contentType: 'text/css' }],
  ['icons.js', { path: join(HUD_ASSET_DIR, 'icons.js'), contentType: 'text/javascript' }],
  ['core.js', { path: join(HUD_ASSET_DIR, 'core.js'), contentType: 'text/javascript' }],
  ['filters.js', { path: join(HUD_ASSET_DIR, 'filters.js'), contentType: 'text/javascript' }],
  ['diagnostics.js', { path: join(HUD_ASSET_DIR, 'diagnostics.js'), contentType: 'text/javascript' }],
  ['network.js', { path: join(HUD_ASSET_DIR, 'network.js'), contentType: 'text/javascript' }],
  ['editor.js', { path: join(HUD_ASSET_DIR, 'editor.js'), contentType: 'text/javascript' }],
  ['inspector.js', { path: join(HUD_ASSET_DIR, 'inspector.js'), contentType: 'text/javascript' }],
]);

const TEMPLATE_PATH = join(HUD_ASSET_DIR, 'index.html');

/**
 * The floating control surface, served by the daemon.
 *
 * Deliberately a single self-contained page with no build step and no external
 * requests: it has to work identically on macOS, Linux and Windows, and open
 * instantly in whatever browser is around. Open it in a small always-on-top
 * window (`baton hud --panel`) and it behaves like an IDE's debug toolbar.
 *
 * The markup, styling and behaviour live in `assets/` as plain HTML/CSS/JS --
 * this just fills in what only the daemon knows at request time: the socket's
 * auth token and the brand assets. Read per-request rather than cached: at
 * this scale a `readFileSync` per page load costs nothing, and it means an
 * edit to `assets/` shows up on the next reload with no daemon restart.
 */
export function renderHud(token: string): string {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replaceAll('%%TOKEN%%', token)
    .replaceAll('%%FAVICON%%', FAVICON)
    .replaceAll('%%CHIP_MARK%%', CHIP_MARK)
    .replaceAll('%%MARK%%', MARK);
}
