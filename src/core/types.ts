/**
 * What a running session can be asked to do.
 *
 * Capabilities are honest: a Vite dev server has no equivalent of Flutter's
 * stateful hot reload, so it does not claim `hotReload`. The HUD greys out what
 * is unavailable and agents get a clear refusal instead of a silent no-op.
 */
export type Capability =
  | 'hotReload'        // re-run changed code, keep state
  | 'hotRestart'       // rebuild from scratch, drop state
  | 'restartProcess'   // kill and respawn the underlying process
  | 'stop'
  | 'screenshot'
  | 'devtools'
  | 'serviceExtension' // framework-specific toggles (debug paint, perf overlay...)
  | 'url'              // exposes a browsable URL
  | 'network';         // live HTTP request capture (VM service / CDP)

export type SessionStatus = 'starting' | 'running' | 'stopped' | 'failed';

export type LogLine = { at: number; text: string; error: boolean };

/** Outcome of a reload/restart. `code: 0` is success; anything else carries `message`. */
export type OperationResult = { code: number; message?: string };

/** Serialised session state, as sent to the HUD, the CLI and MCP clients. */
export type SessionSnapshot = {
  id: string;
  name: string;
  kind: string;
  status: SessionStatus;
  /** Project root this session was started from, so many projects can share a HUD. */
  root?: string;
  target?: string;
  capabilities: Capability[];
  progress?: string;
  url?: string;
  devToolsUri?: string;
  exitCode?: number;
  startedAt: number;
};

export interface Session {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly status: SessionStatus;

  start(): void;
  hotReload(reason?: string): Promise<OperationResult>;
  hotRestart(reason?: string): Promise<OperationResult>;
  stop(): Promise<void>;
  recentLogs(limit?: number): LogLine[];
  snapshot(): SessionSnapshot;

  on(event: 'change' | 'log' | 'exit', listener: (...args: any[]) => void): this;
}

/** Thrown when a session is asked for something its framework cannot do. */
export class UnsupportedCapability extends Error {
  constructor(kind: string, capability: Capability, hint?: string) {
    super(`${kind} sessions do not support ${capability}${hint ? `: ${hint}` : ''}`);
    this.name = 'UnsupportedCapability';
  }
}
