import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-checkout-run-'));

const { LaunchDaemon } = await import('../src/daemon/server.ts');

const scratch = mkdtempSync(join(tmpdir(), 'baton-cr-'));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(process.env.BATON_HOME!, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(scratch, 'repo-'));
  git(dir, ['-c', 'init.defaultBranch=main', 'init']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'demo', scripts: { start: 'true' },
  }));
  writeFileSync(join(dir, 'README.md'), 'main\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
  git(dir, ['checkout', '-b', 'feat/x']);
  writeFileSync(join(dir, 'README.md'), 'feat\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feat']);
  git(dir, ['checkout', 'main']);
  return dir;
}

let daemon: InstanceType<typeof LaunchDaemon>;
before(async () => {
  daemon = new LaunchDaemon('test');
  await daemon.listen(0);
});
after(async () => { await daemon.close(); });

async function waitStopped(id: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const sessions: any[] = await daemon.handle({ method: 'sessions' }) as any[];
    const s = sessions.find((x) => x.id === id);
    if (!s || s.status === 'stopped' || s.status === 'failed') return;
    await new Promise((r) => setTimeout(r, 40));
  }
}

test('run --branch does not move HEAD and forget deletes the owned copy', async () => {
  const repo = makeRepo();
  const listed: any[] = await daemon.handle({ method: 'checkouts', params: { cwd: repo } }) as any[];
  assert.ok(listed.some((e) => e.kind === 'inplace'));
  assert.ok(listed.some((e) => e.ref === 'feat/x'));

  const snapshot: any = await daemon.handle({
    method: 'run', params: { target: 'npm start', cwd: repo, branch: 'feat/x' },
  });
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(snapshot.root, repo);
  assert.equal(snapshot.checkout?.kind, 'owned');
  assert.equal(snapshot.checkout?.ref, 'feat/x');
  assert.notEqual(snapshot.checkout?.cwd, repo);
  assert.equal(readFileSync(join(snapshot.checkout.cwd, 'README.md'), 'utf8').trim(), 'feat');
  const copy = snapshot.checkout.cwd;

  await waitStopped(snapshot.id);
  await daemon.handle({ method: 'forget', params: { session: snapshot.id } });
  assert.equal(existsSync(copy), false);
});

test('run refuses branch and checkout together', async () => {
  const repo = makeRepo();
  await assert.rejects(
    daemon.handle({
      method: 'run', params: { target: 'npm start', cwd: repo, branch: 'feat/x', checkout: repo },
    }),
    /mutually exclusive/,
  );
});

test('proof resolves the requested project and branch before device discovery, then cleans failed preparation', async (t) => {
  const repo = makeRepo();
  const another = makeRepo();
  daemon.projects.remember(another);
  let inspectedRoot = '';
  t.mock.method(daemon.registry, 'devices', (root: string) => {
    inspectedRoot = root;
    return { ready: async () => { throw new Error('test device discovery reached'); } };
  });
  await assert.rejects(daemon.handle({
    method: 'proofRun', params: { cwd: repo, target: 'npm start', branch: 'feat/x' },
  }), /test device discovery reached/);
  assert.notEqual(inspectedRoot, another);
  assert.notEqual(inspectedRoot, repo);
  assert.equal(existsSync(inspectedRoot), false, 'failed proof preparation releases its owned copy');
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});
