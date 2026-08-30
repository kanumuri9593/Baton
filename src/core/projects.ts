import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.ts';

const MAX_REMEMBERED = 12;

function storePath(): string {
  return join(stateDir(), 'projects.json');
}

/**
 * The project roots this machine actually works in, most recent first.
 *
 * The daemon is long-lived and detached, so its own working directory is an
 * accident of wherever it happened to be started. Clients that have no cwd of
 * their own -- the HUD is served in a browser, with no terminal behind it --
 * need a real answer to "which project?", and the honest answer is the ones you
 * have been running.
 */
export class ProjectRegistry {
  #roots: string[] = [];

  constructor() {
    try {
      const stored = JSON.parse(readFileSync(storePath(), 'utf8'));
      if (Array.isArray(stored)) this.#roots = stored.filter((r) => typeof r === 'string');
    } catch {
      // no history yet, or it was corrupted; starting empty is harmless
    }
  }

  /** Record a project as most recently used. */
  remember(root: string): void {
    this.#roots = [root, ...this.#roots.filter((r) => r !== root)].slice(0, MAX_REMEMBERED);
    try {
      writeFileSync(storePath(), JSON.stringify(this.#roots, null, 2));
    } catch {
      // losing history is not worth failing a launch over
    }
  }

  list(): string[] {
    return [...this.#roots];
  }

  /** The project a context-free client should default to. */
  active(): string | undefined {
    return this.#roots[0];
  }
}
