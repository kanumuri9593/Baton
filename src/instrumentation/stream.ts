import { z } from 'zod';
export const TRACE_PREFIX = '@@BATON_TRACE@@';
const rowSchema = z.object({
  id: z.string().max(100), traceId: z.string().regex(/^[a-f0-9]{32}$/), spanId: z.string().max(32),
  parentSpanId: z.string().max(32).optional(), direction: z.enum(['inbound','outbound']),
  method: z.string().max(30), uri: z.string().max(4096), startTime: z.number().finite(),
  durationMs: z.number().finite().nonnegative(), statusCode: z.number().int().optional(),
  error: z.string().max(500).optional(), inProgress: z.literal(false), captureSource: z.literal('otel-node'),
});
export type TraceRow = z.infer<typeof rowSchema>;
/** Keep telemetry out of ordinary logs, including when stdout splits a JSON row. */
export class TraceStream {
  #buffer = '';
  #callbacks: { log(text: string): void; ready(): void; row(row: TraceRow): void };
  constructor(callbacks: { log(text: string): void; ready(): void; row(row: TraceRow): void }) { this.#callbacks = callbacks; }
  write(text: string): void {
    this.#buffer += text;
    let end: number;
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0,end); this.#buffer = this.#buffer.slice(end+1);
      this.#line(line);
    }
    if (this.#buffer.length > 65536) { this.#callbacks.log(this.#buffer.slice(0,65536)); this.#buffer=''; }
  }
  flush(): void { if (this.#buffer) this.#line(this.#buffer); this.#buffer=''; }
  #line(line: string): void {
    if (!line.startsWith(TRACE_PREFIX)) { this.#callbacks.log(line + '\n'); return; }
    try {
      const value = JSON.parse(line.slice(TRACE_PREFIX.length));
      if (value?.ready === true) { this.#callbacks.ready(); return; }
      const parsed = rowSchema.safeParse(value);
      if (parsed.success) this.#callbacks.row(parsed.data);
    } catch { /* malformed telemetry cannot disrupt the application */ }
  }
}
