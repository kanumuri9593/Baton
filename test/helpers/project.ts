import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

/** A portable copy of the original launch example, with empty local config. */
export function fixtureProject(): string {
  const scratch = mkdtempSync(join(tmpdir(), 'baton-fixture-'));
  const root = join(scratch, 'McLane360');
  for (const dir of ['.vscode', '.claude', 'config', 'lib']) mkdirSync(join(root, dir), { recursive: true });
  const launch = readFileSync(new URL('../fixtures/mclane360-launch.json', import.meta.url), 'utf8');
  writeFileSync(join(root, '.vscode/launch.json'), launch);
  writeFileSync(join(root, '.claude/launch.json'), JSON.stringify({ configurations: [{ name: 'docs', runtimeExecutable: 'node', runtimeArgs: ['--version'] }] }));
  writeFileSync(join(root, 'pubspec.yaml'), 'name: example\ndependencies:\n  flutter:\n    sdk: flutter\n');
  writeFileSync(join(root, 'lib/main.dart'), 'void main() {}');
  for (const match of launch.matchAll(/--dart-define-from-file=([^"\s]+)/g)) writeFileSync(join(root, match[1]), '{}');
  after(() => rmSync(scratch, { recursive: true, force: true }));
  return root;
}
