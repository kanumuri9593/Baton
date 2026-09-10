/**
 * Runtime state for a workspace: what the daemon knows about a manifest that is
 * currently up. Manifest *shape* lives in `manifest.ts`; this file is only the
 * live view every surface (CLI, RPC, MCP, HUD) renders.
 */

/** Display-only grouping, so the app can show a database differently to a web app. */
export type NodeKind = 'backend' | 'web' | 'mobile' | 'datastore' | 'queue' | 'other';

/**
 * Where a node is in its lifecycle.
 *
 * `external` is the honest answer for something Baton found already running (a
 * remote endpoint, a container someone else started): it is usable, but Baton
 * did not start it and will not stop it.
 */
export type NodeStatus =
  | 'pending'
  | 'starting'
  | 'ready'
  | 'unhealthy'
  | 'failed'
  | 'skipped'
  | 'stopped'
  | 'external';

export type NodeState = {
  name: string;
  kind: NodeKind;
  provider: string;
  /** Every provider this node offers, so a client can present the choice. */
  providers: string[];
  dependsOn: string[];
  status: NodeStatus;
  sessionId?: string;
  url?: string;
  /** Why this node is `failed`, or which culprit made it `skipped`. */
  error?: string;
  /** True when the session is shared with another workspace, or not ours to stop. */
  readOnly: boolean;
  /** How long this node took to settle, the last time it was started. */
  elapsedMs?: number;
};

export type WorkspaceRun = {
  id: string;
  name: string;
  manifestPath: string;
  root: string;
  startedAt: number;
  nodes: Record<string, NodeState>;
};

export type WorkspaceUpOptions = {
  /** Bring up only these nodes (and what they depend on). Default: everything. */
  nodes?: string[];
  /** One-off provider overrides for this call, `{ node: provider }`. */
  providers?: Record<string, string>;
};

/** `left` names what stayed up on purpose, so "down" is never a silent half-truth. */
export type WorkspaceDownResult = {
  id: string;
  name: string;
  stopped: string[];
  left: string[];
};
