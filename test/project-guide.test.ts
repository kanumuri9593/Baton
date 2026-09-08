import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProject } from '../src/config/guide.ts';
import { loadConfigs, buildFlutterArgv } from '../src/config/loader.ts';
import { configsFromText } from '../src/config/writer.ts';

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'baton-guide-'));
  mkdirSync(join(root, '.vscode'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('fresh inspection sees external edits, malformed sources and nested projects', (t) => {
  const root = setup(t);
  const file = join(root, '.vscode/launch.json');
  writeFileSync(file, JSON.stringify({ configurations: [{ name: 'Dev', type: 'dart' }] }));
  const first = inspectProject(root);
  writeFileSync(file, JSON.stringify({ configurations: [{ name: 'Test', type: 'dart' }] }));
  const second = inspectProject(root);
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(second.targets.map((t) => t.name), ['Test']);
  writeFileSync(file, '{ broken');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'dev:local': 'node app.js' } }));
  mkdirSync(join(root, 'mobile'));
  writeFileSync(join(root, 'mobile/pubspec.yaml'), 'name: mobile');
  const report = inspectProject(root);
  assert.match(report.diagnostics[0].message, /malformed/);
  assert.equal(report.targets[0].name, 'npm dev:local');
  assert.equal(report.children[0].name, 'mobile');
});

test('Drive-style environment flags reach Flutter and inspection excludes their values', (t) => {
  const root = setup(t);
  const file = join(root, '.vscode/launch.json');
  const text = JSON.stringify({ configurations: [{
    name: 'Local lab', type: 'dart', flutterMode: 'profile', cwd: '${workspaceFolder}/mobile',
    program: 'lib/main_local.dart', args: ['--dart-define=API_KEY=private-value', '--dart-define-from-file', 'missing.json', 'app-arg'],
  }] });
  writeFileSync(file, text);
  const [config] = loadConfigs(file, root);
  assert.deepEqual(configsFromText(text, root), [config]);
  assert.equal(config.cwd, join(root, 'mobile'));
  const argv = buildFlutterArgv(config, 'simulator');
  assert.ok(argv.includes('--profile'));
  assert.ok(argv.includes('--dart-define=API_KEY=private-value'));
  assert.deepEqual(argv.slice(-2), ['--dart-entrypoint-args', 'app-arg']);
  const report = inspectProject(root);
  assert.ok(!JSON.stringify(report).includes('private-value'));
  assert.ok(report.targets[0].warnings.length);
  assert.equal(report.targets[0].issues[0].path, 'missing.json');
});

test('duplicate targets and unsupported launches are visible diagnostics', (t) => {
  const root = setup(t);
  writeFileSync(join(root, '.vscode/launch.json'), JSON.stringify({ configurations: [
    { name: 'Dev', type: 'dart' }, { name: 'Dev', type: 'dart' }, { name: 'Attach', type: 'node' },
  ] }));
  const report = inspectProject(root);
  assert.equal(report.targets.length, 1);
  assert.equal(report.diagnostics.length, 2);
});
