import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHIP_COL,
  DEFAULT_INSPECTOR_RATIO,
  GUTTER,
  MIN_INSPECTOR,
  MIN_MAIN,
  MIN_PANE,
  SPLIT_KEY,
  clampDetailWidth,
  clampInspectorWidth,
  parseSplits,
  serializeSplits,
} from '../src/hud/assets/splits.js';

test('parseSplits recovers inspector and detail widths and ignores junk', () => {
  assert.deepEqual(parseSplits(null), { inspector: null, detail: null });
  assert.deepEqual(parseSplits('{'), { inspector: null, detail: null });
  assert.deepEqual(parseSplits('{"inspector":420,"detail":310}'), { inspector: 420, detail: 310 });
  assert.deepEqual(parseSplits('{"inspector":"wide"}'), { inspector: null, detail: null });
});

test('serializeSplits round-trips the two stored numbers', () => {
  const raw = serializeSplits({ inspector: 480, detail: 260 });
  assert.equal(SPLIT_KEY, 'baton.hud.splits');
  assert.deepEqual(parseSplits(raw), { inspector: 480, detail: 260 });
});

test('clampInspectorWidth keeps sessions and inspector above their floors', () => {
  const viewport = 1000;
  const leftover = viewport - CHIP_COL - GUTTER;
  const width = clampInspectorWidth(viewport, 400);
  assert.equal(width, 400);
  assert.ok(leftover - width >= MIN_MAIN);
  assert.ok(width >= MIN_INSPECTOR);
});

test('clampInspectorWidth falls back to the current 1 / 1.35 split', () => {
  const viewport = 980;
  const leftover = viewport - CHIP_COL - GUTTER;
  const width = clampInspectorWidth(viewport, null);
  assert.equal(width, Math.round(leftover * DEFAULT_INSPECTOR_RATIO));
});

test('clampInspectorWidth will not starve the sessions column', () => {
  const viewport = 1000;
  const leftover = viewport - CHIP_COL - GUTTER;
  const width = clampInspectorWidth(viewport, 9000);
  assert.equal(width, leftover - MIN_MAIN);
});

test('clampDetailWidth is 50/50 by default and respects the list floor', () => {
  const inner = 600;
  assert.equal(clampDetailWidth(inner, null), Math.round((inner - GUTTER) / 2));
  assert.equal(clampDetailWidth(inner, 9000), inner - GUTTER - MIN_PANE);
  assert.equal(clampDetailWidth(inner, 50), MIN_PANE);
});
