import { spawn as nodeSpawn } from 'node:child_process';
import { BaseSession, sessionId } from '../core/session-base.ts';
import type { Capability, OperationResult, SessionSnapshot } from '../core/types.ts';
import { MachineCodec, encodeRequest, type DaemonEvent, type DaemonResponse } from '../daemon/protocol.ts';
import { buildFlutterArgv, type LaunchConfig } from '../config/loader.ts';
import type { FlutterBinary } from '../config/flutter.ts';

export type ChildHandle = { write: (line: string) => void; kill: (signal?: string) => void };

export type FlutterSessionOptions = {
  deviceId: string;
  flutter: FlutterBinary;
  /** Injected in tests so a session can be driven without a simulator. */
  spawn?: (command: string, args: string[], cwd: string) => ChildHandle;
};

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'hotReload', 'hotRestart', 'restartProcess', 'stop', 'screenshot', 'devtools', 'serviceExtension',
]);

/**
 * A `flutter run --machine` child, driven over the Flutter daemon protocol.
 *
 * This is the adapter with the richest capabilities, because Flutter exposes a
 * genuine control channel: every button in an IDE's debug toolbar is one request
 * on this connection.
 */
export class FlutterSession extends BaseSession {
  readonly kind = 'flutter';
  readonly capabilities = CAPABILITIES;

  readonly config: LaunchConfig;
  readonly deviceId: string;

  appId?: string;
  vmServiceUri?: string;
  devToolsUri?: string;
  supportsRestart = true;

  #codec = new MachineCodec();
  #child?: ChildHandle;
  #options: FlutterSessionOptions;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(config: LaunchConfig, options: FlutterSessionOptions) {
    super(sessionId(config.cwd, config.name, options.deviceId.slice(0, 8)), config.name);
    this.config = config;
    this.deviceId = options.deviceId;
    this.#options = options;

    this.#codec.on('event', (e: DaemonEvent) => this.#handleEvent(e));
    this.#codec.on('response', (r: DaemonResponse) => this.#handleResponse(r));
    this.#codec.on('raw', (line: string) => this.appendLog(line));
  }

  start(): void {
    const argv = buildFlutterArgv(this.config, this.deviceId);
    const { command, prefixArgs } = this.#options.flutter;
    const args = [...prefixArgs, ...argv];

    if (this.#options.spawn) {
      this.#child = this.#options.spawn(command, args, this.config.cwd);
      return;
    }

    const proc = nodeSpawn(command, args, { cwd: this.config.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.on('data', (c) => this.ingest(c));
    proc.stderr.on('data', (c) => this.appendLog(c.toString(), true));
    proc.on('exit', (code) => this.handleExit(code ?? 0));
    proc.on('error', (err) => {
      this.appendLog(`failed to spawn ${command}: ${err.message}`, true);
      this.setStatus('failed');
      this.#rejectAll(err.message);
    });
    this.#child = {
      write: (line) => proc.stdin.write(line),
      kill: (signal) => proc.kill((signal as NodeJS.Signals) ?? 'SIGTERM'),
    };
  }

  /** Feed raw stdout. Public so tests and replays can drive a session directly. */
  ingest(chunk: string | Buffer): void {
    this.#codec.push(chunk);
  }

  /** Hot reload: re-run changed code, keep app state. */
  hotReload(reason = 'manual'): Promise<OperationResult> {
    return this.#restart(false, reason);
  }

  /** Hot restart: rebuild from scratch, drop app state. */
  hotRestart(reason = 'manual'): Promise<OperationResult> {
    return this.#restart(true, reason);
  }

  async #restart(fullRestart: boolean, reason: string): Promise<OperationResult> {
    const result = await this.#request<OperationResult | null>('app.restart', {
      appId: this.#requireAppId(), fullRestart, pause: false, reason,
    });
    return result ?? { code: 0 };
  }

  async stop(): Promise<void> {
    if (!this.appId) {
      this.#child?.kill();
      return;
    }
    // `app.stop` answers with a bare `true`, so the value is ignored.
    await this.#request('app.stop', { appId: this.appId }).catch(() => this.#child?.kill());
  }

  /** Framework toggles: debug paint, performance overlay, platform override... */
  callServiceExtension(methodName: string, params: Record<string, unknown> = {}) {
    return this.#request('app.callServiceExtension', {
      appId: this.#requireAppId(), methodName, params,
    });
  }

  handleExit(code: number): void {
    this.#codec.flush();
    this.exitCode = code;
    this.setStatus(code === 0 || this.status === 'running' ? 'stopped' : 'failed');
    this.#rejectAll(`session exited with code ${code}`);
    this.emit('exit', code);
  }

  protected extraSnapshot(): Partial<SessionSnapshot> {
    return { target: this.deviceId, devToolsUri: this.devToolsUri };
  }

  #requireAppId(): string {
    if (!this.appId) throw new Error(`${this.name}: app is not running yet (no appId)`);
    return this.appId;
  }

  #request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      if ('appId' in params && !params.appId) throw new Error('app is not running yet');
    } catch (err) {
      return Promise.reject(err as Error);
    }
    if (this.status === 'stopped' || this.status === 'failed') {
      return Promise.reject(new Error(`${this.name}: session has stopped`));
    }

    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#child?.write(encodeRequest(id, method, params) + '\n');
      } catch (err) {
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  #handleEvent(e: DaemonEvent): void {
    switch (e.event) {
      case 'app.start':
        this.appId = e.params.appId;
        if (typeof e.params.supportsRestart === 'boolean') this.supportsRestart = e.params.supportsRestart;
        break;
      case 'app.started':
        this.progress = undefined;
        this.setStatus('running');
        break;
      case 'app.debugPort':
        this.vmServiceUri = e.params.wsUri ?? e.params.baseUri;
        break;
      case 'app.devTools':
        this.devToolsUri = e.params.uri;
        break;
      case 'app.progress':
        this.progress = e.params.finished ? undefined : e.params.message;
        break;
      case 'app.log':
        this.appendLog(String(e.params.log ?? ''), Boolean(e.params.error));
        break;
      case 'app.stop':
        this.setStatus('stopped');
        break;
      case 'daemon.logMessage':
        this.appendLog(String(e.params.message ?? ''), e.params.level === 'error');
        break;
    }
    this.emit('event', e);
    this.emit('change');
  }

  #handleResponse(r: DaemonResponse): void {
    const pending = this.#pending.get(r.id);
    if (!pending) return;
    this.#pending.delete(r.id);
    if (r.error !== undefined) {
      pending.reject(new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error)));
    } else {
      pending.resolve(r.result ?? null);
    }
  }

  #rejectAll(message: string): void {
    for (const [, p] of this.#pending) p.reject(new Error(message));
    this.#pending.clear();
  }
}
