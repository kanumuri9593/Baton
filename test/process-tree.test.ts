import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebDevSession } from '../src/adapters/web-dev.ts';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('stop ends what the script started, not just the script (npm run dev → vite)', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'baton-tree-'));
  const pidFile = join(dir, 'grandchild.pid');
  // A shell that starts a long-lived grandchild and waits on it, the way
  // `npm run dev` sits on top of the real dev server.
  const session = WebDevSession.create('dev', {
    command: 'sh', args: ['-c', `sleep 60 & echo $! > ${pidFile}; wait`], cwd: dir,
  });
  session.start();
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(grandchild), 'the grandchild is running before stop');

  await session.stop();
  for (let i = 0; i < 40 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(grandchild), false, 'the grandchild is gone after stop, so it frees its port');
});
