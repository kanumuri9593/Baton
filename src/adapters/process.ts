import { spawn, type ChildProcess } from 'node:child_process';
import { BaseSession, sessionId } from '../core/session-base.ts';
import type { Capability, OperationResult, SessionSnapshot } from '../core/types.ts';
import { UnsupportedCapability } from '../core/types.ts';

export type ProcessSessionOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Injected in tests. */
  spawnFn?: typeof spawn;
};

/**
 * A supervised child process with no framework-specific control channel.
 *
 * This is the universal fallback: anything in a launch.json or a package.json
 * script can be started, watched and restarted, even when nothing richer exists.
 * Restart means kill-and-respawn, which is honest about what is happening.
 */
export class ProcessSession extends BaseSession {
  readonly kind: string = 'process';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'restartProcess', 'stop',
  ]);

  protected options: ProcessSessionOptions;
  protected child?: ChildProcess;
  #stopping = false;

  constructor(id: string, name: string, options: ProcessSessionOptions) {
    super(id, name);
    this.options = options;
  }

  static forCommand(name: string, options: ProcessSessionOptions): ProcessSession {
    return new ProcessSession(sessionId(options.cwd, name), name, options);
  }

  start(): void {
    this.#stopping = false;
    this.setStatus('starting');

    const spawnFn = this.options.spawnFn ?? spawn;
    const child = spawnFn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Windows, dev servers are usually .cmd shims that need a shell.
      shell: process.platform === 'win32',
    });
    this.child = child;

    child.stdout?.on('data', (c: Buffer) => this.handleOutput(c.toString(), false));
    child.stderr?.on('data', (c: Buffer) => this.handleOutput(c.toString(), true));
    child.on('error', (err: Error) => {
      this.appendLog(`failed to spawn ${this.options.command}: ${err.message}`, true);
      this.setStatus('failed');
    });
    child.on('exit', (code: number | null) => {
      this.exitCode = code ?? 0;
      // An exit we asked for is a stop; an exit we did not ask for is a failure.
      this.setStatus(this.#stopping || code === 0 ? 'stopped' : 'failed');
      this.emit('exit', this.exitCode);
    });

    // A plain process has no "ready" signal, so it counts as running once spawned.
    this.markRunningWhenReady();
  }

  /** Subclasses that can detect readiness from output override this. */
  protected markRunningWhenReady(): void {
    this.setStatus('running');
  }

  /** Subclasses hook here to scrape URLs, readiness and errors out of output. */
  protected handleOutput(text: string, isError: boolean): void {
    this.appendLog(text, isError);
  }

  hotReload(_reason?: string): Promise<OperationResult> {
    return Promise.reject(
      new UnsupportedCapability(this.kind, 'hotReload', 'no control channel; use restart'),
    );
  }

  /** Kill and respawn. The only restart a plain process can offer. */
  async hotRestart(_reason?: string): Promise<OperationResult> {
    await this.stop();
    this.start();
    return { code: 0, message: 'process restarted' };
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || this.#stopping) {
      this.setStatus('stopped');
      return;
    }
    this.#stopping = true;

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);

      if (process.platform === 'win32') {
        // Windows has no signals; taskkill is the reliable way to end a tree.
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }

      // Escalate if the child ignores a polite request.
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 5000);
      timer.unref?.();
      child.once('exit', () => clearTimeout(timer));
    });

    this.setStatus('stopped');
  }
}
