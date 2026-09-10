import type { WaitUntil } from '../daemon/waiter.ts';

/** `--until running|stopped|url|log:<regex>|tcp:<port>|http:<url>` -- `wait`'s one bit of parsing. */
export function parseUntil(raw: string): WaitUntil {
  if (raw.startsWith('log:')) return { log: raw.slice(4) };
  if (raw.startsWith('tcp:')) {
    const port = Number(raw.slice(4));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`--until tcp:<port> needs a port between 1 and 65535 (got "${raw.slice(4)}")`);
    }
    return { tcp: port };
  }
  if (raw.startsWith('http:') || raw.startsWith('https:')) return { http: raw };
  if (raw === 'running' || raw === 'stopped' || raw === 'url') return raw;
  throw new Error(
    `--until must be running, stopped, url, log:<regex>, tcp:<port> or http:<url> (got "${raw}")`,
  );
}

/** `--provider postgres=staging` pairs, as the RPC wants them. */
export function parseProviders(raw: string[]): Record<string, string> {
  const providers: Record<string, string> = {};
  for (const entry of raw) {
    const at = entry.indexOf('=');
    if (at < 1) throw new Error(`--provider needs node=provider (got "${entry}")`);
    providers[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return providers;
}
