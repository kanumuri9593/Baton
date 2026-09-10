import { EventEmitter } from 'node:events';
import type {
  Capability, LogLine, OperationResult, Session, SessionCheckout, SessionSnapshot, SessionStatus,
} from './types.ts';
import { UnsupportedCapability } from './types.ts';

const LOG_RING_SIZE = 2000;

/**
 * Shared machinery for every adapter: status, a bounded log ring, change events.
 *
 * Subclasses implement only what their framework can genuinely do and declare it
 * by passing their initial capabilities to the constructor. Each instance owns
 * its own mutable set -- granting a capability on one session (e.g. once a debug
 * connection is established) must never leak to another session of the same
 * adapter class.
 */
export abstract class BaseSession extends EventEmitter implements Session {
  abstract readonly kind: string;

  readonly id: string;
  readonly name: string;
  readonly startedAt = Date.now();

  status: SessionStatus = 'starting';
  progress?: string;
  exitCode?: number;
  /** OS pid of the spawned child, once it exists. */
  pid?: number;
  /** Set by the registry when the session is created; see SessionSnapshot.root. */
  root?: string;
  /** Set by the registry when a run is not This checkout. */
  checkout?: SessionCheckout;
  /** Set when this session was started as a workflow step. */
  workflow?: string;
  /** Set by the registry when a workspace started this session. */
  workspace?: { id: string; node: string };

  #logs: LogLine[] = [];
  #capabilities: Set<Capability>;
  readonly capabilities: ReadonlySet<Capability>;

  constructor(id: string, name: string, capabilities: Iterable<Capability> = []) {
    super();
    this.id = id;
    this.name = name;
    this.#capabilities = new Set(capabilities);
    this.capabilities = this.#capabilities;
  }

  /** Add a capability at runtime and notify listeners so snapshots rebroadcast. */
  grantCapability(capability: Capability): void {
    this.#capabilities.add(capability);
    this.emit('change');
  }

  abstract start(): void;

  hotReload(_reason?: string): Promise<OperationResult> {
    return Promise.reject(new UnsupportedCapability(this.kind, 'hotReload'));
  }

  hotRestart(_reason?: string): Promise<OperationResult> {
    return Promise.reject(new UnsupportedCapability(this.kind, 'hotRestart'));
  }

  abstract stop(): Promise<void>;

  recentLogs(limit = LOG_RING_SIZE): LogLine[] {
    return this.#logs.slice(-limit);
  }

  protected appendLog(text: string, error = false): void {
    for (const line of String(text).split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed === '') continue;
      const at = Date.now();
      this.#logs.push({ at, text: trimmed, error });
      // The timestamp is passed as a 4th argument (rather than the whole
      // LogLine) so every existing listener -- which only destructures
      // (text, error) -- keeps working unchanged; see SessionRegistry and
      // LaunchDaemon's re-emits, and LogSink, which is the one listener that
      // actually wants it.
      this.emit('log', trimmed, error, at);
    }
    if (this.#logs.length > LOG_RING_SIZE) {
      this.#logs.splice(0, this.#logs.length - LOG_RING_SIZE);
    }
  }

  protected setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('change');
  }

  protected extraSnapshot(): Partial<SessionSnapshot> {
    return {};
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      status: this.status,
      root: this.root,
      capabilities: [...this.capabilities],
      progress: this.progress,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      ...this.extraSnapshot(),
      // Applied after extraSnapshot so a subclass cannot drop the pid by
      // forgetting to spread super.
      ...(this.pid != null ? { pid: this.pid } : {}),
      ...(this.checkout && this.checkout.kind !== 'inplace'
        ? { checkout: this.checkout }
        : {}),
      ...(this.workflow ? { workflow: this.workflow } : {}),
      ...(this.workspace ? { workspace: this.workspace } : {}),
    };
  }
}

/** Stable, filesystem- and URL-safe id fragment. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Build a session id that is unique across projects.
 *
 * Three projects open at once will happily all have an `npm dev`, and two of
 * them may target the same simulator. Without the project prefix the second one
 * to start is rejected as a duplicate of the first.
 */
export function sessionId(cwd: string, name: string, suffix?: string): string {
  const project = slug(cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project');
  return `${project}/${slug(name)}${suffix ? '@' + suffix : ''}`;
}
