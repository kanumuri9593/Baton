import { WebSocket } from 'ws';

/**
 * The Dart VM Service, spoken as plain JSON-RPC 2.0.
 *
 * A Flutter session already hands us a complete, authenticated WebSocket URI in
 * the `app.debugPort` event (`ws://127.0.0.1:PORT/TOKEN=/ws`), so there is
 * nothing to discover or authenticate here -- just frames on a socket. Unlike
 * the `flutter run --machine` protocol next door in `daemon/protocol.ts`, the VM
 * service sends one bare JSON object per frame, with no `[...]` envelope.
 *
 * The transport is an interface rather than a `ws` socket so every test in the
 * suite drives this against a scripted stand-in: `connectVmWs` below is the only
 * function in this feature that opens a real connection, and no test calls it.
 */
export type VmTransport = {
  send(text: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
};

/** A JSON-RPC error response, carrying the code callers actually branch on. */
export class VmServiceError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'VmServiceError';
    this.code = code;
    this.data = data;
  }
}

/** `streamListen` for a stream this connection already subscribed to. */
const ALREADY_SUBSCRIBED = 103;

/**
 * How long to wait for a reply before giving up on one call.
 *
 * The socket being open is not evidence that the VM service is answering: a
 * paused isolate, a wedged app or a half-open connection all accept frames and
 * say nothing back. Without a deadline those calls never settle, and everything
 * waiting on them -- an attach, a poll -- waits forever with nothing logged.
 * Generous enough that a busy app fetching a large body is never cut off.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export type VmServiceClientOptions = {
  /** Per-call deadline. Tests use a few milliseconds. */
  requestTimeoutMs?: number;
};

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export class VmServiceClient {
  #transport: VmTransport;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #streams = new Map<string, Set<(event: any) => void>>();
  #closed = false;
  #timeoutMs: number;

  constructor(transport: VmTransport, options: VmServiceClientOptions = {}) {
    this.#transport = transport;
    this.#timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    transport.onMessage((text) => this.#receive(text));
    // The app being killed (or hot-restarted hard enough) drops the socket; the
    // owner of this client learns about it through its pending calls rejecting.
    transport.onClose(() => this.#finish('vm service connection closed'));
  }

  /** One JSON-RPC call. Resolves with `result`; a JSON-RPC `error` rejects as VmServiceError. */
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('vm service connection closed'));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`vm service did not answer ${method} within ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      // A call in flight must never be the reason the daemon cannot exit.
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        this.#settle(id);
        reject(err as Error);
      }
    });
  }

  /** Forget one pending call and cancel its deadline. */
  #settle(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    return pending;
  }

  /** Register a handler for one stream's `streamNotify` events. */
  onStreamEvent(streamId: string, cb: (event: any) => void): void {
    let handlers = this.#streams.get(streamId);
    if (!handlers) this.#streams.set(streamId, (handlers = new Set()));
    handlers.add(cb);
  }

  /**
   * Subscribe to a stream.
   *
   * Error 103 means this connection is already subscribed, which is exactly the
   * state the caller wanted -- treating it as a failure would turn a harmless
   * re-attach into a dead network pane.
   */
  async streamListen(streamId: string): Promise<void> {
    try {
      await this.request('streamListen', { streamId });
    } catch (err) {
      if (err instanceof VmServiceError && err.code === ALREADY_SUBSCRIBED) return;
      throw err;
    }
  }

  close(): void {
    this.#finish('vm service connection closed');
    this.#transport.close();
  }

  #receive(text: string): void {
    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return; // not our problem: a frame we cannot parse is a frame we ignore
    }
    if (!frame || typeof frame !== 'object') return;

    if (frame.method === 'streamNotify') {
      const streamId = frame.params?.streamId;
      const handlers = this.#streams.get(streamId);
      if (!handlers) return;
      for (const handler of handlers) {
        // One handler throwing must not swallow the event for the others, nor
        // escape into the socket's message callback.
        try {
          handler(frame.params?.event);
        } catch (err) {
          console.error(`baton: vm stream handler for ${streamId} threw: ${(err as Error).message}`);
        }
      }
      return;
    }

    if (typeof frame.id !== 'number') return;
    const pending = this.#settle(frame.id);
    if (!pending) return; // a reply to a call we already gave up on
    if (frame.error) {
      pending.reject(
        new VmServiceError(
          Number(frame.error.code ?? 0),
          String(frame.error.message ?? 'vm service error'),
          frame.error.data,
        ),
      );
    } else {
      pending.resolve(frame.result);
    }
  }

  /** Mark closed and fail everything still in flight -- once, however we got here. */
  #finish(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}

/**
 * Open a real WebSocket to a VM service URI.
 *
 * The only place in this feature that touches the network. It is injected into
 * `NetworkService` so tests never reach it.
 */
export function connectVmWs(uri: string, timeoutMs = 5000): Promise<VmTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(uri);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error(`vm service at ${uri} did not answer within ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        send: (text) => socket.send(text),
        onMessage: (cb) => socket.on('message', (raw) => cb(raw.toString())),
        onClose: (cb) => socket.on('close', cb),
        close: () => socket.close(),
      });
    });
    socket.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}
