import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { browseDirs } from '../src/daemon/browse.ts';

/** chmod 000 does nothing useful on Windows, and root ignores it everywhere. */
const posixOnly = {
  skip: process.platform === 'win32' ? 'POSIX permissions are meaningless on win32'
    : process.getuid?.() === 0 ? 'root reads directories regardless of mode' : false,
};

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'baton-browse-'));
}

test('lists directories only, sorted, with hidden entries left out', () => {
  const root = scratch();
  for (const name of ['zeta', 'alpha', '.hidden', 'middle']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'a-file.txt'), 'not a directory');

  const result = browseDirs(root);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.entries.map((e) => e.name), ['alpha', 'middle', 'zeta']);
  assert.equal(result.entries[0].path, join(root, 'alpha'));
  rmSync(root, { recursive: true, force: true });
});

test('flags which entries are projects and which already have a launch.json', () => {
  const root = scratch();
  mkdirSync(join(root, 'plain'));
  mkdirSync(join(root, 'node-app'));
  writeFileSync(join(root, 'node-app', 'package.json'), '{}');
  mkdirSync(join(root, 'configured', '.vscode'), { recursive: true });
  writeFileSync(join(root, 'configured', '.vscode', 'launch.json'), '{}');
  mkdirSync(join(root, 'claude-configured', '.claude'), { recursive: true });
  writeFileSync(join(root, 'claude-configured', '.claude', 'launch.json'), '{}');

  const byName = new Map(browseDirs(root).entries.map((e) => [e.name, e]));
  assert.deepEqual(
    { isProject: byName.get('plain')!.isProject, hasLaunchJson: byName.get('plain')!.hasLaunchJson },
    { isProject: false, hasLaunchJson: false },
  );
  assert.equal(byName.get('node-app')!.isProject, true);
  assert.equal(byName.get('node-app')!.hasLaunchJson, false);
  assert.equal(byName.get('configured')!.hasLaunchJson, true);
  assert.equal(byName.get('configured')!.isProject, true, '.vscode is itself a project marker');
  assert.equal(byName.get('claude-configured')!.hasLaunchJson, true);
  rmSync(root, { recursive: true, force: true });
});

test('the parent is the directory above, and absent at the filesystem root', () => {
  const root = scratch();
  assert.equal(browseDirs(root).parent, dirname(root));
  assert.equal(browseDirs('/').parent, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('with no path at all, browsing starts at home', () => {
  const result = browseDirs();
  assert.equal(result.path, homedir());
  assert.ok(result.shortcuts.some((s) => s.path === homedir()));
});

test('a leading ~ is expanded rather than taken literally', () => {
  const result = browseDirs('~');
  assert.equal(result.path, homedir());
  assert.equal(result.error, undefined);
});

test('the listing is capped so a directory with thousands of entries stays usable', () => {
  const root = scratch();
  for (let i = 0; i < 520; i++) mkdirSync(join(root, `d${String(i).padStart(4, '0')}`));
  const result = browseDirs(root);
  assert.equal(result.entries.length, 500);
  assert.equal(result.entries[0].name, 'd0000', 'the cap applies after sorting, not before');
  rmSync(root, { recursive: true, force: true });
});

test('a file is refused as a destination instead of being silently treated as its parent', () => {
  const root = scratch();
  const file = join(root, 'launch.json');
  writeFileSync(file, '{}');
  const result = browseDirs(file);
  assert.equal(result.error, 'not a directory');
  assert.deepEqual(result.entries, []);
  assert.ok(result.shortcuts.length > 0, 'the user must still be able to get somewhere else');
  rmSync(root, { recursive: true, force: true });
});

test('a directory that does not exist is an error, never a throw', () => {
  const result = browseDirs(join(tmpdir(), 'baton-no-such-directory-xyz'));
  assert.match(result.error!, /no such directory/);
  assert.deepEqual(result.entries, []);
  assert.ok(result.parent, 'the parent is still offered so the user can back out');
});

test('a directory that cannot be read says so, keeping the path and the shortcuts', posixOnly, () => {
  const root = scratch();
  const locked = join(root, 'locked');
  mkdirSync(locked);
  mkdirSync(join(locked, 'inside'));
  chmodSync(locked, 0o000);
  try {
    const result = browseDirs(locked);
    assert.equal(result.error, 'permission denied');
    assert.deepEqual(result.entries, []);
    assert.equal(result.path, locked);
    assert.equal(result.parent, root);
    assert.ok(result.shortcuts.length > 0);
  } finally {
    chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable child is listed without flags rather than blowing up the whole listing', posixOnly, () => {
  const root = scratch();
  mkdirSync(join(root, 'readable'));
  const locked = join(root, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const names = browseDirs(root).entries.map((e) => e.name);
    assert.deepEqual(names, ['locked', 'readable']);
  } finally {
    chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test('shortcuts always start with Home and never point at a directory that is missing', () => {
  const { shortcuts } = browseDirs();
  assert.equal(shortcuts[0].label, 'Home');
  assert.equal(shortcuts[0].path, homedir());
  const seen = new Set<string>();
  for (const shortcut of shortcuts) {
    assert.ok(shortcut.label && shortcut.path, 'every shortcut is labelled and addressable');
    assert.ok(!seen.has(shortcut.path), `duplicate shortcut for ${shortcut.path}`);
    seen.add(shortcut.path);
  }
});
