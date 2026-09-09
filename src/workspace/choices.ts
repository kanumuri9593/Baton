import { readFileSync, writeFileSync } from 'node:fs';
import { workspacesStorePath } from '../core/paths.ts';

type Store = Record<string, Record<string, string>>;

/**
 * Which provider this machine last used for each node, keyed by manifest path.
 *
 * Deliberately not in the committed manifest: "I am pointing the API at
 * staging today" is a local, personal choice, and committing it would flip it
 * for the whole team. The manifest's `defaults` remain the team's answer.
 */
export class WorkspaceChoices {
  #store: Store = {};

  constructor() {
    try {
      const stored = JSON.parse(readFileSync(workspacesStorePath(), 'utf8'));
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [manifestPath, choices] of Object.entries(stored as Store)) {
          if (!choices || typeof choices !== 'object' || Array.isArray(choices)) continue;
          const clean: Record<string, string> = {};
          for (const [node, provider] of Object.entries(choices)) {
            if (typeof provider === 'string') clean[node] = provider;
          }
          this.#store[manifestPath] = clean;
        }
      }
    } catch {
      // no choices yet, or the file was corrupted; the defaults are a fine answer
    }
  }

  get(manifestPath: string): Record<string, string> {
    return { ...this.#store[manifestPath] };
  }

  set(manifestPath: string, node: string, provider: string): void {
    this.#store[manifestPath] = { ...this.#store[manifestPath], [node]: provider };
    try {
      writeFileSync(workspacesStorePath(), JSON.stringify(this.#store, null, 2));
    } catch {
      // remembering is a convenience; failing to is not worth failing a switch over
    }
  }
}
