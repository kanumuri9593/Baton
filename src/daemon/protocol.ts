import { EventEmitter } from 'node:events';

/** A daemon event, e.g. `app.started`, `device.added`. */
export type DaemonEvent = { event: string; params: Record<string, any> };

/** A reply to a request we sent. `result` is absent on a bare success. */
export type DaemonResponse = { id: number; result?: unknown; error?: unknown; trace?: unknown };

/**
 * Framing codec for the Flutter machine/daemon protocol.
 *
 * The wire format, verified against Flutter 3.38.2, is one message per line,
 * wrapped in a single-element JSON array:
 *
 *     [{"event":"app.started","params":{"appId":"..."}}]
 *     [{"id":2}]
 *
 * Lines that are not protocol messages are interleaved freely -- the tool prints
 * things like `Launching lib/main.dart on iPhone 17 Pro in debug mode...` straight
 * to stdout. Those are surfaced as `raw` and must never break parsing, because a
 * single unparseable line would otherwise take down a running session.
 */
export class MachineCodec extends EventEmitter {
  #buffer = '';

  /** Feed a stdout chunk. Emits `event`, `response`, and `raw`. */
  push(chunk: string | Buffer): void {
    this.#buffer += chunk.toString();

    const lines = this.#buffer.split('\n');
    // The final element is whatever follows the last newline: an incomplete
    // line that must stay buffered until its terminator arrives.
    this.#buffer = lines.pop() ?? '';

    for (const line of lines) this.#handleLine(line.replace(/\r$/, ''));
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;

    // Protocol messages always arrive as an array envelope. Anything else is
    // human-facing output, not something to parse.
    if (!trimmed.startsWith('[')) {
      this.emit('raw', line);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.emit('raw', line);
      return;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      this.emit('raw', line);
      return;
    }

    for (const message of parsed) {
      if (!message || typeof message !== 'object') {
        this.emit('raw', line);
        continue;
      }
      const m = message as Record<string, unknown>;
      if (typeof m.event === 'string') {
        this.emit('event', { event: m.event, params: (m.params ?? {}) as Record<string, any> });
      } else if (typeof m.id === 'number') {
        this.emit('response', m as DaemonResponse);
      } else {
        this.emit('raw', line);
      }
    }
  }

  /** Anything still buffered when the stream ends, so a final unterminated line is not lost. */
  flush(): void {
    if (this.#buffer.trim() !== '') {
      const remaining = this.#buffer;
      this.#buffer = '';
      this.#handleLine(remaining);
    }
  }
}

/** Serialise a request in the envelope the daemon expects. */
export function encodeRequest(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify([{ id, method, params }]);
}
