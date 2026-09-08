import { fixtureProject } from './helpers/project.ts';
const FIXTURE_PROJECT = fixtureProject();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTargets, detectPackageManager } from '../src/config/detect.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'baton-detect-'));
}

test('detects Next.js dev script as a web-dev target', () => {
  const root = scratch();
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'next dev', build: 'next build' },
    dependencies: { next: '15.0.0' },
  }));
  const targets = detectTargets(root);
  const dev = targets.find((t) => t.name.endsWith('dev'))!;
  assert.equal(dev.kind, 'web-dev');
  assert.equal(dev.source, 'package.json');
  assert.deepEqual(dev.args, ['run', 'dev']);
  rmSync(root, { recursive: true, force: true });
});

test('detects React Native start script as a react-native target', () => {
  const root = scratch();
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { start: 'react-native start' },
    dependencies: { 'react-native': '0.76.0' },
  }));
  const [target] = detectTargets(root);
  assert.equal(target.kind, 'react-native');
  rmSync(root, { recursive: true, force: true });
});

test('detects a Flutter project with no launch.json', () => {
  const root = scratch();
  writeFileSync(join(root, 'pubspec.yaml'), 'name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n');
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'lib', 'main.dart'), 'void main() {}');
  const [target] = detectTargets(root);
  assert.equal(target.kind, 'flutter');
  assert.equal(target.source, 'auto');
  assert.equal(target.config!.program, 'lib/main.dart');
  rmSync(root, { recursive: true, force: true });
});

test('picks the package manager from the lockfile that is present', () => {
  const root = scratch();
  assert.equal(detectPackageManager(root).command, 'npm');
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  assert.equal(detectPackageManager(root).command, 'pnpm');
  rmSync(root, { recursive: true, force: true });
});

test('discovers all 16 real McLane360 launch configs as flutter targets', () => {
  const targets = detectTargets(FIXTURE_PROJECT);
  const flutter = targets.filter((t) => t.kind === 'flutter' && t.source === 'launch.json');
  assert.equal(flutter.length, 16);
  // the .claude/launch.json docs server is a plain process target
  assert.ok(targets.some((t) => t.name === 'docs' && t.kind === 'process'));
});

test('a malformed launch.json does not hide package.json targets', () => {
  const root = scratch();
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), '{ this is not json');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'vite' }, devDependencies: { vite: '5.0.0' },
  }));
  const targets = detectTargets(root);
  assert.ok(targets.some((t) => t.kind === 'web-dev'));
  rmSync(root, { recursive: true, force: true });
});
