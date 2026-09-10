import { dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { BaseSession, sessionId } from '../core/session-base.ts';

export type ComposeSessionOptions = {
  /** Absolute path to the Compose file, as resolved from the manifest. */
  file: string;
  service: string;
  /** Folder whose basename prefixes the session id (the HUD project). */
  idRoot?: string;
  /** Injected in tests. */
  spawnFn?: typeof spawn;
};

export const DOCKER_MISSING_HINT =
  'docker was not found on PATH. Install Docker (Baton uses Compose v2 — `docker compose`, not the '
  + 'old `docker-compose`), or point this node somewhere else with `baton switch <node> <provider>`.';

export const COMPOSE_MISSING_HINT =
  'this docker has no `docker compose` (Compose v2). Install the Compose plugin — the old, separate '
  + '`docker-compose` binary is not it — or point this node somewhere else with '
  + '`baton switch <node> <provider>`.';

/**
 * What a `docker` that cannot do Compose says.
 *
 * Docker installed without the Compose plugin is common (a plain CLI from a
 * package manager), and it fails by treating `compose` as garbage: the user is
 * shown "unknown shorthand flag: 'f'", which explains nothing at all.
 */
const NO_COMPOSE_PLUGIN = /unknown shorthand flag|unknown command|not a docker command|is not a docker/i;

/**
 * One Compose service, as a Baton session.
 *
 * Compose is a *provider*, not a new kind of launch target: nothing detects it
 * from a repository, so it never needs to appear in the target model. What it
 * does need is the session model — status, logs, stop — which is what this is.
 *
 * The important promise is ownership. If the container was already running
 * before Baton looked, the session is marked `external`: its logs are still
 * followed, but it is never stopped, because somebody else started it and may
 * still be using it.
 */
export class ComposeSession extends BaseSession {
  readonly kind = 'compose';

  /** True when the container was already up before Baton asked. */
  external = false;

  readonly options: ComposeSessionOptions;
  #logs?: ChildProcess;
  #stopping = false;

  constructor(id: string, name: string, options: ComposeSessionOptions) {
    // Capabilities start empty and are granted once ownership is known: a
    // container Baton did not start must not advertise a stop button.
    super(id, name, []);
    this.options = options;
  }

  static forService(options: ComposeSessionOptions): ComposeSession {
    const name = `compose: ${options.service}`;
    return new ComposeSession(
      sessionId(options.idRoot ?? dirname(options.file), options.service),
      name,
      options,
    );
  }

  start(): void {
    this.#stopping = false;
    this.setStatus('starting');
    void this.#bringUp();
  }

  async #bringUp(): Promise<void> {
    const running = await this.#run(['ps', '--format', 'json', '--status', 'running', this.options.service]);
    if (running.spawnError) return this.#failToSpawn(running.spawnError);
    if (running.code !== 0 && NO_COMPOSE_PLUGIN.test(running.stderr)) {
      return this.#fail(`${COMPOSE_MISSING_HINT}\n${running.stderr.trim()}`);
    }

    if (running.code === 0 && running.stdout.trim() !== '') {
      this.external = true;
      this.appendLog(`${this.options.service} was already running; Baton will not stop it`);
      this.#followLogs();
      this.setStatus('running');
      return;
    }

    const up = await this.#run(['up', '-d', this.options.service]);
    if (up.spawnError) return this.#failToSpawn(up.spawnError);
    if (up.code !== 0) {
      this.appendLog(up.stderr.trim() || `docker compose up exited ${up.code}`, true);
      this.exitCode = up.code ?? 1;
      this.setStatus('failed');
      this.emit('exit', this.exitCode);
      return;
    }

    this.grantCapability('stop');
    this.grantCapability('restartProcess');
    this.#followLogs();
    this.setStatus('running');
  }

  #failToSpawn(error: NodeJS.ErrnoException): void {
    this.#fail(error.code === 'ENOENT' ? DOCKER_MISSING_HINT : `docker compose failed: ${error.message}`);
  }

  #fail(message: string): void {
    this.appendLog(message, true);
    this.exitCode = 1;
    this.setStatus('failed');
    this.emit('exit', this.exitCode);
  }

  /**
   * Follow the service's output for as long as the session lives.
   *
   * `up -d` returns immediately by design, so it can say nothing about whether
   * the container stays up. This long-lived child is what does: if it ends
   * while Baton still believes the service is running, the container is gone.
   */
  #followLogs(): void {
    const child = this.#spawn(['logs', '-f', '--no-log-prefix', this.options.service]);
    this.#logs = child;
    this.pid = child.pid;
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString(), false));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString(), true));
    child.on('error', (error: Error) => this.appendLog(`could not follow logs: ${error.message}`, true));
    child.on('exit', () => {
      this.pid = undefined;
      if (this.#stopping || this.status === 'stopped' || this.status === 'failed') return;
      this.appendLog(`${this.options.service} stopped following logs; the container is no longer running`, true);
      this.exitCode = 1;
      this.setStatus('failed');
      this.emit('exit', this.exitCode);
    });
  }

  async hotRestart(): Promise<{ code: number; message?: string }> {
    if (this.external) return { code: 1, message: `${this.options.service} is external; Baton did not start it` };
    await this.stop();
    this.start();
    return { code: 0, message: `${this.options.service} restarted` };
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;

    this.#logs?.kill();
    this.#logs = undefined;
    this.pid = undefined;

    if (!this.external) {
      const stopped = await this.#run(['stop', this.options.service]);
      if (stopped.code !== 0 && !stopped.spawnError) {
        this.appendLog(stopped.stderr.trim() || `docker compose stop exited ${stopped.code}`, true);
      }
    }

    this.setStatus('stopped');
    this.emit('exit', this.exitCode ?? 0);
  }

  #spawn(args: string[]): ChildProcess {
    const spawnFn = this.options.spawnFn ?? spawn;
    // `shell: false` everywhere, including Windows: `docker` is a native
    // executable, and a shell would only make quoting depend on the arguments.
    return spawnFn('docker', ['compose', '-f', this.options.file, ...args], {
      cwd: dirname(this.options.file),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  }

  /** One short-lived `docker compose` command, awaited to completion. */
  #run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException }> {
    return new Promise((resolve) => {
      const child = this.#spawn(args);
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', (error: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, spawnError: error }));
      child.once('exit', (code: number | null) => resolve({ code, stdout, stderr }));
    });
  }
}
