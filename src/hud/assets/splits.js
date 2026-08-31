/**
 * Independent HUD column widths.
 *
 * Two stored numbers: the inspector column (Logs / Network) and the Network
 * detail pane. Sessions get whatever is left. Chip and peek densities ignore
 * this; only the expanded inspector uses it.
 */

export const SPLIT_KEY = 'baton.hud.splits';
export const CHIP_COL = 52;
export const GUTTER = 8;
export const MIN_MAIN = 240;
export const MIN_INSPECTOR = 280;
export const MIN_PANE = 180;
/** Matches the previous `1fr` / `1.35fr` body grid. */
export const DEFAULT_INSPECTOR_RATIO = 1.35 / (1 + 1.35);

/**
 * @param {unknown} raw
 * @returns {{ inspector: number | null, detail: number | null }}
 */
export function parseSplits(raw) {
  if (typeof raw !== 'string' || !raw) return { inspector: null, detail: null };
  try {
    const data = JSON.parse(raw);
    const inspector = Number.isFinite(data.inspector) ? data.inspector : null;
    const detail = Number.isFinite(data.detail) ? data.detail : null;
    return { inspector, detail };
  } catch {
    return { inspector: null, detail: null };
  }
}

/**
 * @param {{ inspector: number | null, detail: number | null }} splits
 */
export function serializeSplits(splits) {
  return JSON.stringify({ inspector: splits.inspector, detail: splits.detail });
}

/**
 * Inspector column width in CSS pixels for the expanded HUD.
 *
 * @param {number} viewport
 * @param {number | null} stored
 */
export function clampInspectorWidth(viewport, stored) {
  const leftover = viewport - CHIP_COL - GUTTER;
  if (leftover <= 0) return 0;
  const floor = Math.min(MIN_INSPECTOR, leftover);
  const ceiling = Math.max(floor, leftover - MIN_MAIN);
  const fallback = leftover * DEFAULT_INSPECTOR_RATIO;
  const value = stored == null ? fallback : stored;
  return Math.round(Math.min(ceiling, Math.max(floor, value)));
}

/**
 * Network detail pane width inside the inspector.
 *
 * @param {number} inner
 * @param {number | null} stored
 */
export function clampDetailWidth(inner, stored) {
  const leftover = inner - GUTTER;
  if (leftover <= 0) return 0;
  const floor = Math.min(MIN_PANE, leftover);
  const ceiling = Math.max(floor, leftover - MIN_PANE);
  const fallback = leftover / 2;
  const value = stored == null ? fallback : stored;
  return Math.round(Math.min(ceiling, Math.max(floor, value)));
}

/**
 * Read stored splits. Private mode and corrupt JSON both look like "never set".
 *
 * @param {{ getItem: (key: string) => string | null }} [store]
 */
export function loadSplits(store) {
  try {
    return parseSplits(store ? store.getItem(SPLIT_KEY) : localStorage.getItem(SPLIT_KEY));
  } catch {
    return { inspector: null, detail: null };
  }
}

/**
 * @param {{ inspector: number | null, detail: number | null }} splits
 * @param {{ setItem: (key: string, value: string) => void }} [store]
 */
export function saveSplits(splits, store) {
  const raw = serializeSplits(splits);
  try {
    if (store) store.setItem(SPLIT_KEY, raw);
    else localStorage.setItem(SPLIT_KEY, raw);
  } catch { /* private mode */ }
}

/**
 * Drag a vertical gutter. `onDelta` receives pixels the pointer moved left
 * (positive = grow the pane on the right).
 *
 * @param {HTMLElement} el
 * @param {(delta: number) => void} onDelta
 * @param {() => void} [onEnd]
 */
export function wireGutter(el, onDelta, onEnd) {
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    let last = event.clientX;
    const move = (next) => {
      onDelta(last - next.clientX);
      last = next.clientX;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (onEnd) onEnd();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}
