import { z } from 'zod';
import type { LogLine, Session } from '../core/types.ts';
import type { NetworkStore } from '../core/network-store.ts';
export const diagnoseSchema = z.object({
  root: z.string().optional(),
  sessions: z.array(z.string()).max(16).optional(),
  query: z.string().max(200).default(''),
  errorsOnly: z.boolean().default(true),
  since: z.number().finite().optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export type DiagnoseParams = z.input<typeof diagnoseSchema>;

/**
 * One distinct problem. Repeats of the same line (the same error on every
 * request) collapse into one finding with a `count`, and the stack frames
 * printed under an error belong to it instead of being findings of their own.
 */
export type Finding = {
  /** When it last happened (epoch ms). */
  at: number;
  kind: 'log' | 'network';
  /** The newest occurrence, verbatim (capped at 1000 characters). */
  message: string;
  /** How many times it happened, when more than once. */
  count?: number;
  /** When it first happened, when more than once. */
  firstAt?: number;
  /** The first meaningful stack frames, with the project root shortened to `./`. */
  frames?: string[];
  /** Frames left out of `frames`. */
  moreFrames?: number;
  traceId?: string;
  requestId?: string;
};

/** The findings of one session; its id, status and project root are given once. */
export type SessionFindings = { session: string; status: Session['status']; root?: string; findings: Finding[] };

export type DiagnoseResult = {
  /** Distinct findings across every session searched, before `limit`. */
  total: number;
  truncated: boolean;
  /** Every session searched, in scope order, with its findings newest first. */
  sessions: SessionFindings[];
};

/** A stack frame line from JS/Java (`at …`), Dart (`#0 …`), Python (`File "…"`) or Java's `... N more`. */
const FRAME = /^\s+at\s|^#\d+\s+\S|^\s+File ".*", line \d+|^\s*\.\.\. \d+ more\b/;
/** Frames in the runtime or a dependency, which rarely say where to fix. */
const INTERNAL_FRAME = /\(node:|\bat node:|node:internal|\/node_modules\/|\(dart:|\bpackage:flutter\//;
const KEEP_FRAMES = 3;
/** A timestamp a logger put at the start of a line, so repeats of the same line compare equal. */
const LEADING_TIME = /^\[?(\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}([.,]\d+)?(Z|[+-]\d{2}:?\d{2})?\]?\s*/;

/** Keep the first few frames that point at the app's own code, and count the rest. */
export function collapseFrames(frames: string[], root?: string): { frames: string[]; moreFrames?: number } {
  if (!frames.length) return { frames: [] };
  const short = frames.map((f) => shortenPath(f.trim(), root));
  const meaningful = short.filter((f) => !INTERNAL_FRAME.test(f));
  const kept = (meaningful.length ? meaningful : short).slice(0, KEEP_FRAMES);
  const more = short.length - kept.length;
  return more > 0 ? { frames: kept, moreFrames: more } : { frames: kept };
}

function shortenPath(frame: string, root?: string): string {
  if (!root) return frame;
  const base = root.endsWith('/') ? root : `${root}/`;
  return frame.split(`file://${base}`).join('./').split(base).join('./');
}

export function diagnose(sessions: Session[], store: NetworkStore, input: unknown): DiagnoseResult {
  const p = diagnoseSchema.parse(input);
  const query = p.query.toLowerCase();
  const scope = sessions.filter((s) => (!p.root || s.root === p.root) && (!p.sessions || p.sessions.includes(s.id)));
  const all: { session: string; finding: Finding }[] = [];
  for (const s of scope) {
    const byKey = new Map<string, Finding>();
    const add = (key: string, f: Finding) => {
      const seen = byKey.get(key);
      if (!seen) { byKey.set(key, f); return; }
      seen.count = (seen.count ?? 1) + 1;
      if (f.at >= seen.at) {
        seen.firstAt = Math.min(seen.firstAt ?? seen.at, f.at);
        Object.assign(seen, { ...f, count: seen.count, firstAt: seen.firstAt });
      } else {
        seen.firstAt = Math.min(seen.firstAt ?? seen.at, f.at);
      }
    };
    const logs: LogLine[] = s.recentLogs();
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (p.since !== undefined && log.at < p.since) continue;
      if (p.errorsOnly && !log.error && !/\b(error|exception|failed)\b/i.test(log.text)) continue;
      // The stack printed right under a matching line is part of that finding.
      const stack: string[] = [];
      let j = i + 1;
      if (!FRAME.test(log.text)) {
        while (j < logs.length && FRAME.test(logs[j].text)) stack.push(logs[j++].text);
      }
      const matches = (log.text + '\n' + stack.join('\n')).toLowerCase().includes(query);
      if (!matches) continue;
      i = j - 1;
      const message = log.text.slice(0, 1000);
      const collapsed = collapseFrames(stack, s.root);
      const finding: Finding = { at: log.at, kind: 'log', message };
      if (collapsed.frames.length) finding.frames = collapsed.frames;
      if (collapsed.moreFrames) finding.moreFrames = collapsed.moreFrames;
      add(`log\n${message.replace(LEADING_TIME, '')}\n${collapsed.frames.join('\n')}`, finding);
    }
    for (const row of store.list(s.id, { tail: 500, since: p.since })) {
      if (p.errorsOnly && !row.error && (row.statusCode ?? 0) < 400) continue;
      const outcome = `${row.method} ${row.uri} · ${row.error ?? row.statusCode ?? 'pending'}`;
      const message = `${outcome} · ${Math.round(row.durationMs ?? 0)}ms`;
      if (!(message + ' ' + (row.traceId ?? '')).toLowerCase().includes(query)) continue;
      add(`net\n${outcome}\n${row.traceId ?? ''}`, { at: row.startTime, kind: 'network', message, traceId: row.traceId, requestId: row.id });
    }
    for (const finding of byKey.values()) all.push({ session: s.id, finding });
  }
  all.sort((a, b) => b.finding.at - a.finding.at);
  const shown = all.slice(0, p.limit);
  return {
    total: all.length,
    truncated: all.length > p.limit,
    sessions: scope.map((s) => ({
      session: s.id,
      status: s.status,
      ...(s.root ? { root: s.root } : {}),
      findings: shown.filter((x) => x.session === s.id).map((x) => x.finding),
    })),
  };
}

/** `16:27:36.918Z`: the time of day is what tells findings apart within a run. */
function clock(at: number): string {
  return new Date(at).toISOString().slice(11);
}

/**
 * The result as compact text for an agent: each session and its project root
 * once, then one line per finding with its stack collapsed beneath it.
 */
export function formatDiagnose(r: DiagnoseResult): string {
  const shown = r.sessions.reduce((n, s) => n + s.findings.length, 0);
  const lines = [
    r.total === 0
      ? `no findings in ${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'}`
      : `${r.total} finding${r.total === 1 ? '' : 's'}, newest first${r.truncated ? ` (showing ${shown}; raise limit or add a query for more)` : ''}`,
  ];
  for (const s of r.sessions) {
    lines.push(`${s.session}  ${s.status}${s.root ? `  ${s.root}` : ''}`);
    for (const f of s.findings) {
      const repeat = f.count ? ` ×${f.count} since ${clock(f.firstAt ?? f.at)}` : '';
      const ids = [f.traceId && `trace=${f.traceId}`, f.requestId && `request=${f.requestId}`].filter(Boolean).join(' ');
      lines.push(`  ${clock(f.at)} ${f.kind}${repeat}  ${f.message}${ids ? `  ${ids}` : ''}`);
      for (const frame of f.frames ?? []) lines.push(`      ${frame}`);
      if (f.moreFrames) lines.push(`      +${f.moreFrames} more frame${f.moreFrames === 1 ? '' : 's'}`);
    }
  }
  return lines.join('\n');
}
