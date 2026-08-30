import { WebSocket } from 'ws';
import { ProcessSession, type ProcessSessionOptions } from './process.ts';
import { sessionId } from '../core/session-base.ts';
import type { Capability, OperationResult, SessionSnapshot } from '../core/types.ts';

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'hotRestart', 'restartProcess', 'stop', 'url',
]);

const DEFAULT_METRO_PORT = 8081;

export type ReactNativeOptions = ProcessSessionOptions & { metroPort?: number };

/**
 * A React Native Metro bundler.
 *
 * Metro exposes a broadcast channel at `ws://<host>/message` that the dev menu
 * uses. Sending `{"method":"reload"}` there is exactly what pressing `r` in the
 * Metro terminal does, so a full reload can be triggered without a TTY.
 *
 * Fast Refresh (the stateful equivalent of Flutter's hot reload) is applied by
 * the bundler on save with no external trigger, so `hotReload` is not claimed;
 * `hotRestart` maps to the reload broadcast.
 */
export class ReactNativeSession extends ProcessSession {
  readonly kind = 'react-native';
  readonly capabilities = CAPABILITIES;

  readonly metroPort: number;
  #ready = false;

  constructor(id: string, name: string, options: ReactNativeOptions) {
    super(id, name, options);
    this.metroPort = options.metroPort ?? DEFAULT_METRO_PORT;
  }

  static create(name: string, options: ReactNativeOptions): ReactNativeSession {
    return new ReactNativeSession(sessionId(options.cwd, name), name, options);
  }

  get url(): string {
    return `http://localhost:${this.metroPort}`;
  }

  protected markRunningWhenReady(): void {
    this.setStatus('starting');
  }

  protected handleOutput(text: string, isError: boolean): void {
    super.handleOutput(text, isError);
    if (!this.#ready && /(Dev server ready|Welcome to Metro|Fast Refresh|waiting on)/i.test(text)) {
      this.#ready = true;
      this.setStatus('running');
    }
  }

  /** Broadcast a reload to every connected dev client, as the dev menu does. */
  hotRestart(_reason?: string): Promise<OperationResult> {
    return this.#broadcast('reload');
  }

  #broadcast(method: string): Promise<OperationResult> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://localhost:${this.metroPort}/message`);
      const finish = (result: OperationResult) => {
        try { socket.close(); } catch { /* already closing */ }
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ code: 1, message: `Metro did not respond on port ${this.metroPort}` }),
        4000,
      );
      timer.unref?.();

      socket.on('open', () => {
        socket.send(JSON.stringify({ version: 2, method }));
        clearTimeout(timer);
        // The broadcast channel does not acknowledge; a successful send is the signal.
        setTimeout(() => finish({ code: 0, message: `${method} broadcast to dev clients` }), 150);
      });
      socket.on('error', (err: Error) => {
        clearTimeout(timer);
        finish({ code: 1, message: `Metro unreachable: ${err.message}` });
      });
    });
  }

  protected extraSnapshot(): Partial<SessionSnapshot> {
    return { url: this.url, target: `metro:${this.metroPort}` };
  }
}
