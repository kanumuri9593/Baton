import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckoutStore } from '../src/core/checkouts.ts';

const scratch = mkdtempSync(join(tmpdir(), 'baton-checkouts-'));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message]);
}

/** A small repo with a gitignored secret and a second branch. */
function makeRepo(): string {
  const dir = mkdtempSync(join(scratch, 'repo-'));
  git(dir, ['-c', 'init.defaultBranch=main', 'init']);
  writeFileSync(join(dir, '.gitignore'), 'secrets.local.json\nbuild/\n.dart_tool/\n.env\n');
  writeFileSync(join(dir, 'README.md'), 'main\n');
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'dev.json'), '{"ok":true}\n');
  writeFileSync(join(dir, 'secrets.local.json'), 'KEEP-ME\n');
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'build', 'cache.bin'), 'HUGE\n');
  writeFileSync(join(dir, '.env'), 'TOKEN=local\n');
  commitAll(dir, 'init');

  git(dir, ['checkout', '-b', 'feat/x']);
  writeFileSync(join(dir, 'README.md'), 'feat\n');
  commitAll(dir, 'feat');
  git(dir, ['checkout', 'main']);
  return dir;
}

let home: string;
let store: CheckoutStore;

before(() => {
  home = mkdtempSync(join(scratch, 'home-'));
  store = new CheckoutStore({ home });
});

test('a folder that is not a git repo only offers This checkout', () => {
  const dir = mkdtempSync(join(scratch, 'plain-'));
  const listed = store.list(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, 'inplace');
  assert.equal(listed[0].group, 'this');
  assert.equal(store.resolve(dir).kind, 'inplace');
  assert.equal(store.resolve(dir).cwd, dir);
});

test('lists This checkout, local branches, and linked worktrees', () => {
  const repo = makeRepo();
  const wt = join(scratch, 'agent-a');
  git(repo, ['worktree', 'add', wt, 'feat/x']);

  const listed = store.list(repo);
  const kinds = listed.map((e) => `${e.group}:${e.kind}:${e.ref ?? e.label}`);
  assert.ok(kinds.some((k) => k.startsWith('this:inplace')), kinds.join(','));
  assert.ok(kinds.some((k) => k.includes('worktree') && k.includes('feat/x')), kinds.join(','));
  assert.ok(kinds.some((k) => k === 'local:ref:feat/x' || k.endsWith('ref:feat/x')), kinds.join(','));
  assert.ok(kinds.some((k) => k.includes('ref:main')), kinds.join(','));
});

test('creating an owned copy leaves the source HEAD and copies secrets not build/', () => {
  const repo = makeRepo();
  const before = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(before, 'main');

  const checkout = store.resolve(repo, { branch: 'feat/x' });
  assert.equal(checkout.kind, 'owned');
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(readFileSync(join(checkout.cwd, 'README.md'), 'utf8'), 'feat\n');
  assert.equal(readFileSync(join(checkout.cwd, 'secrets.local.json'), 'utf8'), 'KEEP-ME\n');
  assert.equal(readFileSync(join(checkout.cwd, '.env'), 'utf8'), 'TOKEN=local\n');
  assert.equal(existsSync(join(checkout.cwd, 'build', 'cache.bin')), false);
  assert.notEqual(checkout.cwd, repo);
});

test('resolve of the same branch reuses the owned copy', () => {
  const repo = makeRepo();
  const first = store.resolve(repo, { branch: 'feat/x' });
  const second = store.resolve(repo, { branch: 'feat/x' });
  assert.equal(first.cwd, second.cwd);
  assert.equal(second.kind, 'owned');
});

test('a branch already checked out in the source still gets a detached owned copy', () => {
  const repo = makeRepo();
  const checkout = store.resolve(repo, { branch: 'main' });
  assert.equal(checkout.kind, 'owned');
  assert.notEqual(checkout.cwd, repo);
  assert.equal(readFileSync(join(checkout.cwd, 'README.md'), 'utf8'), 'main\n');
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});

test('picking an existing worktree path attaches and forget does not delete it', () => {
  const repo = makeRepo();
  const wt = join(scratch, 'agent-b');
  git(repo, ['worktree', 'add', wt, 'feat/x']);
  writeFileSync(join(wt, 'secrets.local.json'), 'AGENT\n');

  const checkout = store.resolve(repo, { checkout: wt });
  assert.equal(checkout.kind, 'attached');
  assert.equal(checkout.cwd, wt);
  // Missing .env is filled from the source; the agent's secret is not overwritten.
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'TOKEN=local\n');
  assert.equal(readFileSync(join(wt, 'secrets.local.json'), 'utf8'), 'AGENT\n');

  assert.equal(store.release(checkout, false), false);
  assert.equal(existsSync(wt), true);
});

test('forget removes an owned copy only when nothing else is using it', () => {
  const repo = makeRepo();
  const checkout = store.resolve(repo, { branch: 'feat/x' });
  assert.equal(existsSync(checkout.cwd), true);

  assert.equal(store.release(checkout, true), false, 'still used — keep the folder');
  assert.equal(existsSync(checkout.cwd), true);

  assert.equal(store.release(checkout, false), true);
  assert.equal(existsSync(checkout.cwd), false);
});

test('branch and checkout together are rejected', () => {
  const repo = makeRepo();
  assert.throws(
    () => store.resolve(repo, { branch: 'feat/x', checkout: repo }),
    /pick one|mutually exclusive/i,
  );
});

test('a checkout path that is not a worktree of this repo is rejected', () => {
  const repo = makeRepo();
  const other = makeRepo();
  assert.throws(
    () => store.resolve(repo, { checkout: other }),
    /not a worktree/i,
  );
});
