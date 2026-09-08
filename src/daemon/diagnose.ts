import { z } from 'zod';
import type { Session } from '../core/types.ts';
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
export type Finding = { session: string; root?: string; at: number; kind: 'log' | 'network'; message: string; traceId?: string; requestId?: string };
export function diagnose(sessions: Session[], store: NetworkStore, input: unknown) {
  const p = diagnoseSchema.parse(input);
  const query = p.query.toLowerCase();
  const matches: Finding[] = [];
  const scope = sessions.filter((s) => (!p.root || s.root === p.root) && (!p.sessions || p.sessions.includes(s.id)));
  for (const s of scope) {
    for (const log of s.recentLogs()) {
      if (p.since !== undefined && log.at < p.since) continue;
      if (p.errorsOnly && !log.error && !/\b(error|exception|failed)\b/i.test(log.text)) continue;
      if (!log.text.toLowerCase().includes(query)) continue;
      matches.push({session:s.id,root:s.root,at:log.at,kind:'log',message:log.text.slice(0,1000)});
    }
    for (const row of store.list(s.id,{tail:500,since:p.since})) {
      if (p.errorsOnly && !row.error && (row.statusCode ?? 0) < 400) continue;
      const message = `${row.method} ${row.uri} · ${row.error ?? row.statusCode ?? 'pending'} · ${Math.round(row.durationMs ?? 0)}ms`;
      if (!(message+' '+(row.traceId ?? '')).toLowerCase().includes(query)) continue;
      matches.push({session:s.id,root:s.root,at:row.startTime,kind:'network',message,traceId:row.traceId,requestId:row.id});
    }
  }
  matches.sort((a,b)=>b.at-a.at);
  return {scope:scope.map(s=>({session:s.id,status:s.status,root:s.root})),total:matches.length,findings:matches.slice(0,p.limit),truncated:matches.length>p.limit};
}
export type DiagnoseResult = ReturnType<typeof diagnose>;
