import { EventEmitter } from 'node:events';
import type {
  Capability, LogLine, OperationResult, Session, SessionSnapshot, SessionStatus,
} from './types.ts';
import { UnsupportedCapability } from './types.ts';

const LOG_RING_SIZE = 2000;

/**
 * Shared machinery for every adapter: status, a bounded log ring, change events.
 *
 * Subclasses implement only what their framework can genuinely do and declare it
 * through `capabilities`.
 */
export abstract class BaseSession extends EventEmitter implements Session {
  abstract readonly kind: string;
  abstract readonly capabilities: ReadonlySet<Capability>;

  readonly id: string;
  readonly name: string;
  readonly startedAt = Date.now();

  status: SessionStatus = 'starting';
  progress?: string;
  exitCode?: number;

  #logs: LogLine[] = [];

  constructor(id: string, name: string) {
    super();
    this.id = id;
    this.name = name;
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
      this.#logs.push({ at: Date.now(), text: trimmed, error });
      this.emit('log', trimmed, error);
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
      capabilities: [...this.capabilities],
      progress: this.progress,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      ...this.extraSnapshot(),
    };
  }
}

/** Stable, filesystem- and URL-safe id fragment. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
