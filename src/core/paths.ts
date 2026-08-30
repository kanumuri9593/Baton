import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Where CLI-Launch keeps its runtime state.
 *
 * `~/.clilaunch` resolves correctly on Windows, macOS and Linux; the override
 * exists so tests and sandboxes never touch a real user's directory.
 */
export function stateDir(): string {
  const dir = process.env.CLILAUNCH_HOME ?? join(homedir(), '.clilaunch');
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
