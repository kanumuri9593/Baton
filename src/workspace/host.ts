import type { SessionSnapshot } from '../core/types.ts';
import type { WaitUntil } from '../daemon/waiter.ts';
import type { NetProbe } from '../daemon/probes.ts';

export type TargetRunRequest = {
  cwd: string;
  /** Launch target name, matched inside `cwd`. */
  name: string;
  branch?: string;
  checkout?: string;
  device?: string;
  env: Record<string, string>;
  workspace: { id: string; node: string };
  /** The workspace name, so clients that only understand workflows still group these. */
  workflow: string;
};

export type ComposeRunRequest = {
  file: string;
  service: string;
  /** Project root the HUD groups this under. */
  root: string;
  workspace: { id: string; node: string };
  workflow: string;
};

/**
 * Everything the engine needs the daemon to actually do.
 *
 * The engine owns ordering, attribution and ownership rules; this is the seam
 * where those decisions turn into processes. Injecting it is what lets the
 * engine's behaviour be tested without Docker, a simulator, or a real port.
 */
export type WorkspaceHost = {
  runTarget(request: TargetRunRequest): Promise<SessionSnapshot>;
  runCompose(request: ComposeRunRequest): Promise<{ session: SessionSnapshot; external: boolean }>;
  /** Block until a session satisfies a readiness condition. Rejects with why it could not. */
  waitFor(sessionId: string, until: WaitUntil, timeoutMs: number): Promise<{ url?: string }>;
  /** Check an address with no session behind it: a remote node, or the health loop. */
  probe(probe: NetProbe, timeoutMs: number): Promise<void>;
  stop(sessionId: string): Promise<void>;
};
