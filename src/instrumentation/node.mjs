// Loaded before a Node application using NODE_OPTIONS=--import=... .
// OpenTelemetry supplies HTTP/fetch interception and W3C trace propagation.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

const prefix = '@@BATON_TRACE@@';
const emit = (row) => process.stdout.write(prefix + JSON.stringify(row) + '\n');
const millis = ([seconds, nanos]) => seconds * 1000 + nanos / 1e6;
const cleanUrl = (raw) => {
  try { const url = new URL(raw); return url.origin + url.pathname; }
  catch { return String(raw ?? '/').split(/[?#]/)[0]; }
};
const exporter = {
  export(spans, done) {
    for (const span of spans) {
      const a = span.attributes;
      const method = a['http.request.method'] ?? a['http.method'];
      if (!method) continue;
      const code = a['http.response.status_code'] ?? a['http.status_code'];
      const context = span.spanContext();
      emit({
        id: context.traceId + '#' + context.spanId,
        traceId: context.traceId, spanId: context.spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        direction: span.kind === 1 ? 'inbound' : 'outbound',
        method, uri: cleanUrl(a['url.full'] ?? a['http.url'] ?? a['url.path'] ?? a['http.target']),
        startTime: millis(span.startTime), durationMs: millis(span.duration),
        statusCode: code,
        error: span.status.code === 2 || Number(code) >= 400 ? (code ? `HTTP ${code}` : 'Transport error') : undefined,
        inProgress: false, captureSource: 'otel-node',
      });
    }
    done({ code: 0 });
  },
  shutdown: async () => {},
};
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
registerInstrumentations({ instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()] });
// Patch builtins before ESM apps bind named imports such as createServer.
const require = createRequire(import.meta.url);
require('node:http'); require('node:https');
syncBuiltinESMExports();
emit({ ready: true });
