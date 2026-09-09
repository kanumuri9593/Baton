import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Where Baton keeps its runtime state.
 *
 * `~/.baton` resolves correctly on Windows, macOS and Linux; the override
 * exists so tests and sandboxes never touch a real user's directory.
 */
export function stateDir(): string {
  const dir = process.env.BATON_HOME ?? join(homedir(), '.baton');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function handshakePath(): string {
  return join(stateDir(), 'daemon.json');
}

export function logDir(): string {
  const dir = join(stateDir(), 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where persisted per-run session logs live, one JSONL file per run. */
export function sessionLogDir(): string {
  const dir = join(logDir(), 'sessions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where proof bundles are written — one directory per `baton proof` run. */
export function proofsDir(): string {
  const dir = join(stateDir(), 'proofs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Git worktrees Baton created so a session can run a ref without moving the
 * user's current checkout. Created on demand; never a substitute for `stateDir`.
 */
export function worktreesDir(): string {
  const dir = join(stateDir(), 'worktrees');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Owned-checkout records, so a daemon restart can reuse or delete copies. */
export function checkoutsStorePath(): string {
  return join(stateDir(), 'checkouts.json');
}

/**
 * Per-machine workspace provider choices, keyed by manifest path.
 *
 * Separate from the committed manifest because "my API points at staging" is a
 * local decision, not one to push onto the rest of the team.
 */
export function workspacesStorePath(): string {
  return join(stateDir(), 'workspaces.json');
}
