import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseSession, sessionId } from '../core/session-base.ts';
import type { Capability, OperationResult, SessionSnapshot } from '../core/types.ts';

const CAPABILITIES: readonly Capability[] = ['restartProcess', 'stop', 'screenshot'];

export type NativeSpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown },
) => ChildProcess;

export type NativeBuildOptions = {
  cwd: string;
  command: string;
  args: string[];
  deviceId: string;
  env?: Record<string, string>;
  idRoot?: string;
  checkoutSlug?: string;
  spawnFn?: NativeSpawnFn;
};

/**
 * Build, install and launch a native iOS or Android app, then keep the session
 * alive on the app's log stream.
 *
 * There is no portable hot-reload channel. Restart rebuilds and relaunches.
 * The session stays `running` while the launched app is attached, so logs and
 * screenshots have something to talk to — a compile that exits 0 is not a run.
 */
export class NativeBuildSession extends BaseSession {
  readonly kind: 'ios' | 'android';
  readonly deviceId: string;

  #options: NativeBuildOptions;
  #child?: ChildProcess;
  #stopping = false;
  #appId?: string;
  #generation = 0;

  constructor(kind: 'ios' | 'android', id: string, name: string, options: NativeBuildOptions) {
    super(id, name, CAPABILITIES);
    this.kind = kind;
    this.deviceId = options.deviceId;
    this.#options = options;
  }

  static create(kind: 'ios' | 'android', name: string, options: NativeBuildOptions): NativeBuildSession {
    const suffix = [options.deviceId.slice(0, 8), options.checkoutSlug].filter(Boolean).join('+');
    return new NativeBuildSession(
      kind,
      sessionId(options.idRoot ?? options.cwd, name, suffix),
      name,
      options,
    );
  }

  start(): void {
    this.#stopping = false;
    this.setStatus('starting');
    this.progress = 'building';
    void this.#pipeline();
  }

  async hotRestart(_reason?: string): Promise<OperationResult> {
    await this.#detach(false);
    this.#stopping = false;
    this.setStatus('starting');
    this.progress = 'rebuilding';
    await this.#pipeline();
    return { code: this.status === 'running' ? 0 : 1, message: this.status === 'running' ? 'rebuilt and relaunched' : 'rebuild failed' };
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#detach(true);
    this.setStatus('stopped');
  }

  protected extraSnapshot(): Partial<SessionSnapshot> {
    return { target: this.deviceId };
  }

  async #pipeline(): Promise<void> {
    const gen = ++this.#generation;
    try {
      switch (this.kind) {
        case 'ios':
          await this.#runIos();
          break;
        case 'android':
          await this.#runAndroid();
          break;
        default: {
          const _exhaustive: never = this.kind;
          throw new Error(`unknown native kind: ${_exhaustive}`);
        }
      }
    } catch (err) {
      if (this.#stopping || gen !== this.#generation) return;
      this.appendLog((err as Error).message, true);
      this.setStatus('failed');
      this.emit('exit', this.exitCode ?? 1);
    }
  }

  async #runIos(): Promise<void> {
    const derived = join(this.#options.cwd, '.baton', 'DerivedData');
    const args = withIosDestination(this.#options.args, this.deviceId, derived);
    this.appendLog(`xcodebuild ${args.join(' ')}`);
    const code = await this.#runToExit(this.#options.command, args, {});
    if (code !== 0) {
      this.exitCode = code;
      throw new Error(`xcodebuild exited ${code}`);
    }

    const app = findBuiltApp(derived) ?? findBuiltApp(join(this.#options.cwd, 'build'));
    if (!app) throw new Error('xcodebuild succeeded but no .app was found under DerivedData');
    this.appendLog(`installing ${app}`);
    const installed = await this.#runToExit('xcrun', ['simctl', 'install', this.deviceId, app], {});
    if (installed !== 0) throw new Error(`simctl install exited ${installed}`);

    const bundle = (await this.#capture('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Info.plist')])).trim();
    if (!bundle) throw new Error(`could not read CFBundleIdentifier from ${app}`);
    this.#appId = bundle;
    this.appendLog(`launching ${bundle}`);
    this.progress = 'running';
    this.#follow('xcrun', ['simctl', 'launch', '--console', this.deviceId, bundle], {});
    this.setStatus('running');
  }

  async #runAndroid(): Promise<void> {
    if (!this.#options.args.some((arg) => /install/i.test(arg))) {
      throw new Error('this Android target only compiles; add an application module so Baton can install and launch it');
    }
    const env = { ...process.env, ...this.#options.env, ANDROID_SERIAL: this.deviceId };
    this.appendLog(`${this.#options.command} ${this.#options.args.join(' ')}`);
    const code = await this.#runToExit(this.#options.command, this.#options.args, { env });
    if (code !== 0) {
      this.exitCode = code;
      throw new Error(`gradle exited ${code}`);
    }

    const appId = findAndroidApplicationId(this.#options.cwd);
    if (!appId) throw new Error('install succeeded but no applicationId was found in Gradle outputs');
    this.#appId = appId;
    this.appendLog(`launching ${appId}`);
    const launched = await this.#runToExit('adb', [
      '-s', this.deviceId, 'shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1',
    ], {});
    if (launched !== 0) throw new Error(`adb launch exited ${launched}`);

    const pid = (await this.#capture('adb', ['-s', this.deviceId, 'shell', 'pidof', '-s', appId])).trim().split(/\s+/)[0];
    this.progress = 'running';
    if (pid && /^\d+$/.test(pid)) {
      this.#follow('adb', ['-s', this.deviceId, 'logcat', '--pid', pid], {});
    } else {
      this.appendLog('app launched; pid not available, following device logcat');
      this.#follow('adb', ['-s', this.deviceId, 'logcat'], {});
    }
    this.setStatus('running');
  }

  async #detach(terminateApp: boolean): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.pid = undefined;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        child.once('exit', done);
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 3000);
        timer.unref?.();
      });
    }
    if (terminateApp && this.#appId) {
      if (this.kind === 'ios') {
        await this.#runToExit('xcrun', ['simctl', 'terminate', this.deviceId, this.#appId], {});
      } else {
        await this.#runToExit('adb', ['-s', this.deviceId, 'shell', 'am', 'force-stop', this.#appId], {});
      }
    }
  }

  #spawn(command: string, args: string[], extra: { env?: NodeJS.ProcessEnv }): ChildProcess {
    const spawnFn = this.#options.spawnFn ?? spawn;
    return spawnFn(command, args, {
      cwd: this.#options.cwd,
      env: extra.env ?? { ...process.env, ...this.#options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  #attachLogs(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString(), false));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString(), true));
    child.on('error', (err: Error) => this.appendLog(`failed to spawn: ${err.message}`, true));
  }

  #runToExit(command: string, args: string[], extra: { env?: NodeJS.ProcessEnv }): Promise<number> {
    return new Promise((resolve) => {
      const child = this.#spawn(command, args, extra);
      this.#child = child;
      this.pid = child.pid;
      this.#attachLogs(child);
      const finish = (code: number) => {
        if (this.#child === child) {
          this.#child = undefined;
          this.pid = undefined;
        }
        resolve(code);
      };
      child.on('exit', (code) => finish(code ?? 1));
      child.on('error', () => finish(1));
    });
  }

  async #capture(command: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = this.#spawn(command, args, {});
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString(), true));
      child.on('exit', () => resolve(out));
      child.on('error', () => resolve(''));
    });
  }

  #follow(command: string, args: string[], extra: { env?: NodeJS.ProcessEnv }): void {
    const child = this.#spawn(command, args, extra);
    this.#child = child;
    this.pid = child.pid;
    this.#attachLogs(child);
    child.on('exit', (code) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.pid = undefined;
      this.exitCode = code ?? 0;
      if (this.#stopping) {
        this.setStatus('stopped');
        return;
      }
      this.setStatus(code === 0 ? 'stopped' : 'failed');
      this.emit('exit', this.exitCode);
    });
  }
}

export function withIosDestination(args: string[], deviceId: string, derivedData: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-destination' || args[i] === '-sdk' || args[i] === '-derivedDataPath') {
      i += 1;
      continue;
    }
    if (args[i] === 'build') continue;
    out.push(args[i]);
  }
  out.push('-destination', `id=${deviceId}`, '-derivedDataPath', derivedData, 'CODE_SIGNING_ALLOWED=NO', 'build');
  return out;
}

export function findBuiltApp(root: string): string | undefined {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || found.length > 20) return;
    for (const entry of safelyReadDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.app') && !/tests\.app$/i.test(entry.name)) {
        found.push(full);
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => Number(b.includes('iphonesimulator')) - Number(a.includes('iphonesimulator')) || a.localeCompare(b));
  return found[0];
}

export function findAndroidApplicationId(root: string): string | undefined {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 10 || files.length > 20) return;
    for (const entry of safelyReadDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === 'output-metadata.json') files.push(full);
      else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'intermediates') walk(full, depth + 1);
    }
  };
  walk(root, 0);
  for (const file of files) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { applicationId?: string };
      if (typeof doc.applicationId === 'string' && doc.applicationId) return doc.applicationId;
    } catch { /* skip unreadable metadata */ }
  }
  return undefined;
}

function safelyReadDir(dir: string) {
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}
