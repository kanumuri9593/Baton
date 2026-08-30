import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFlutter } from '../src/config/flutter.ts';

/** Build a throwaway project root; returns its path. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baton-'));
  return dir;
}

/** Create a fake SDK tree with an executable bin/flutter, return the SDK root. */
function fakeSdk(root: string, version = '3.38.2'): string {
  const sdk = join(root, 'sdk', version);
  mkdirSync(join(sdk, 'bin'), { recursive: true });
  const bin = join(sdk, 'bin', 'flutter');
  writeFileSync(bin, '#!/bin/sh\necho "Flutter 3.38.2"\n');
  chmodSync(bin, 0o755);
  return sdk;
}

test('prefers the project .fvm/flutter_sdk symlink over anything on PATH', () => {
  const root = project();
  const sdk = fakeSdk(root);
  mkdirSync(join(root, '.fvm'), { recursive: true });
  symlinkSync(sdk, join(root, '.fvm', 'flutter_sdk'));

  const resolved = resolveFlutter(root);
  assert.equal(resolved.source, 'fvm-sdk');
  assert.equal(resolved.command, join(root, '.fvm', 'flutter_sdk', 'bin', 'flutter'));
  assert.deepEqual(resolved.prefixArgs, []);
  rmSync(root, { recursive: true, force: true });
});

test('falls back to the fvm CLI when .fvmrc pins a version but the SDK link is absent', () => {
  const root = project();
  writeFileSync(join(root, '.fvmrc'), JSON.stringify({ flutter: '3.38.2' }));

  const resolved = resolveFlutter(root, { hasFvmCli: true });
  assert.equal(resolved.source, 'fvm-cli');
  assert.equal(resolved.command, 'fvm');
  assert.deepEqual(resolved.prefixArgs, ['flutter']);
  rmSync(root, { recursive: true, force: true });
});

test('a broken .fvm symlink does not resolve to a dead path', () => {
  const root = project();
  mkdirSync(join(root, '.fvm'), { recursive: true });
  // dangling: points at an SDK that was deleted (a stale fvm install)
  symlinkSync(join(root, 'sdk', 'gone'), join(root, '.fvm', 'flutter_sdk'));

  const resolved = resolveFlutter(root, { hasFvmCli: false });
  assert.notEqual(resolved.source, 'fvm-sdk');
  assert.equal(resolved.command, 'flutter');
  rmSync(root, { recursive: true, force: true });
});

test('plain project with no FVM uses flutter from PATH', () => {
  const root = project();
  const resolved = resolveFlutter(root, { hasFvmCli: false });
  assert.equal(resolved.source, 'path');
  assert.equal(resolved.command, 'flutter');
  assert.deepEqual(resolved.prefixArgs, []);
  rmSync(root, { recursive: true, force: true });
});

test('reports the pinned version from .fvmrc so a mismatch can be surfaced', () => {
  const root = project();
  writeFileSync(join(root, '.fvmrc'), JSON.stringify({ flutter: '3.38.2' }));
  const resolved = resolveFlutter(root, { hasFvmCli: true });
  assert.equal(resolved.pinnedVersion, '3.38.2');
  rmSync(root, { recursive: true, force: true });
});

test('resolves the real McLane360 project to its pinned FVM SDK', () => {
  const real = '/Users/yxkanum/Documents/McLane360';
  const resolved = resolveFlutter(real);
  assert.equal(resolved.source, 'fvm-sdk');
  assert.equal(resolved.pinnedVersion, '3.38.2');
});
