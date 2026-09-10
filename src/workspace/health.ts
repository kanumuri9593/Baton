import { isProbe, type NetProbe } from '../daemon/probes.ts';
import type { Readiness } from './manifest.ts';

/** The probe behind a readiness declaration, when there is one worth repeating. */
export function repeatableProbe(ready: Readiness | undefined, url: string | undefined): NetProbe | undefined {
  if (isProbe(ready)) return ready;
  // 'running', 'url' and log matching all describe a moment, not a condition
  // that can be re-checked later, so they get no ongoing health check.
  void url;
  return undefined;
}

export type HealthCheck = {
  node: string;
  probe: NetProbe;
  timeoutMs: number;
};

/**
 * Re-checks the nodes that declared a real probe, long after bring-up.
 *
 * A node that answered once and stopped answering is `unhealthy`, not `ready` —
 * and nothing is stopped or restarted in response, because a blip is not a
 * reason to take a developer's system apart. The interval is injectable so
 * tests do not wait fifteen seconds to see a flip.
 */
export class NodeHealth {
  #timer?: ReturnType<typeof setInterval>;
  #checks = new Map<string, HealthCheck>();
  #running = false;

  #probeFn: (probe: NetProbe, timeoutMs: number) => Promise<void>;
  #onResult: (node: string, healthy: boolean, detail?: string) => void;
  #intervalMs: number;

  constructor(
    probeFn: (probe: NetProbe, timeoutMs: number) => Promise<void>,
    onResult: (node: string, healthy: boolean, detail?: string) => void,
    intervalMs: number,
  ) {
    this.#probeFn = probeFn;
    this.#onResult = onResult;
    this.#intervalMs = intervalMs;
  }

  watch(check: HealthCheck): void {
    this.#checks.set(check.node, check);
    this.#ensureTimer();
  }

  forget(node: string): void {
    this.#checks.delete(node);
    if (this.#checks.size === 0) this.dispose();
  }

  #ensureTimer(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, this.#intervalMs);
    // The daemon must still be able to exit while a workspace is up.
    this.#timer.unref?.();
  }

  /** One round over every watched node. Exposed so tests need no wall clock. */
  async tick(): Promise<void> {
    if (this.#running) return; // a slow round must not stack up behind itself
    this.#running = true;
    try {
      await Promise.all([...this.#checks.values()].map(async (check) => {
        try {
          await this.#probeFn(check.probe, check.timeoutMs);
          this.#onResult(check.node, true);
        } catch (error) {
          this.#onResult(check.node, false, (error as Error).message);
        }
      }));
    } finally {
      this.#running = false;
    }
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
