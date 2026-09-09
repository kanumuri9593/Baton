import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readHandshake, type Handshake } from '../daemon/server.ts';
import { logDir, stateDir } from './paths.ts';
import { resolveRuntimeEntry } from './runtime-entry.ts';
import { openSync, closeSync, mkdirSync, statSync, rmSync } from 'node:fs';
import type { RpcMethods } from './api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = resolveRuntimeEntry(join(HERE, '..', 'daemon'), 'main');

/**
 * Thin client for the daemon, used by both the CLI and the MCP server.
 *
 * Starts the daemon on demand, so no one has to remember to launch it first --
 * `baton run` from a cold machine just works.
 */
export class DaemonClient {
  #socket?: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #listeners = new Set<(message: any) => void>();

  async connect(autoStart = true): Promise<void> {
    let handshake = readHandshake();
    if (handshake && !(await isAlive(handshake))) handshake = undefined;
    if (!handshake && autoStart) handshake = await startDaemon();
    if (!handshake) throw new Error('no daemon running (start one with `baton daemon start`)');

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${handshake.port}?token=${handshake.token}`);
      this.#socket = socket;

      socket.on('open', () => resolve());
      socket.on('error', (err: Error) => reject(err));
      socket.on('close', () => {
        for (const [, p] of this.#pending) p.reject(new Error('daemon connection closed'));
        this.#pending.clear();
      });
      socket.on('message', (raw) => {
        let message: any;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (typeof message.id === 'number' && this.#pending.has(message.id)) {
          const pending = this.#pending.get(message.id)!;
          this.#pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
          return;
        }
        for (const listener of this.#listeners) listener(message);
      });
    });
  }

  /** Subscribe to pushed events (`session`, `log`). */
  onEvent(listener: (message: any) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Typed against the daemon's RPC contract for every known method. */
  call<K extends keyof RpcMethods>(
    method: K,
    params?: RpcMethods[K]['params'],
  ): Promise<RpcMethods[K]['result']>;
  /** Untyped fallback, for a method not yet in `RpcMethods` (forward-compat). */
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error('not connected'));
    const id = this.#nextId++;
    return new Promise<any>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.#socket?.close();
    this.#socket = undefined;
  }
}

async function isAlive(handshake: Handshake): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${handshake.port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Launch a detached daemon and wait for it to publish a handshake. */
export async function startDaemon(timeoutMs = 20000): Promise<Handshake> {
  const deadline = Date.now() + timeoutMs;
  const lock = join(stateDir(), 'daemon-start.lock');
  for (;;) {
    const existing = readHandshake();
    if (existing && await isAlive(existing)) return existing;
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A crashed starter must not permanently prevent future launches.
      try { if (Date.now() - statSync(lock).mtimeMs > 60000) rmSync(lock, { recursive: true }); } catch { /* another starter released it */ }
      if (Date.now() >= deadline) throw new Error('Another daemon is starting. Retry shortly.');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  try {
    const existing = readHandshake();
    if (existing && await isAlive(existing)) return existing;
    const out = openSync(join(logDir(), 'daemon.log'), 'a');
    const child = spawn(process.execPath, [DAEMON_ENTRY], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    closeSync(out);
    let failure: Error | undefined;
    child.on('error', (error) => { failure = error; });
    child.unref();
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const handshake = readHandshake();
      if (handshake && handshake.pid === child.pid && (await isAlive(handshake))) return handshake;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`daemon did not start within ${timeoutMs}ms; see ${join(logDir(), 'daemon.log')}`);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
