// A small orders API with request logging, in the style of a typical Node service.
// One endpoint has a real bug (order 13 has no totals object) and the payments
// upstream is flaky, so the log holds a few errors among many ordinary lines.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 43150);
const orders = new Map();
for (let i = 1; i <= 40; i++) {
  orders.set(i, { id: i, customer: `customer-${i}`, totals: i === 13 ? undefined : { net: 10 * i, tax: i } });
}
const ts = () => new Date().toISOString();
const log = (level, msg) => console.log(`${ts()} ${level.padEnd(5)} ${msg}`);
let paymentsCalls = 0;

function orderTotal(order) {
  return order.totals.net + order.totals.tax; // bug: order 13 has no totals
}

const server = createServer((req, res) => {
  const started = performance.now();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const done = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    log('info', `${req.method} ${url.pathname} ${status} ${(performance.now() - started).toFixed(1)}ms`);
  };
  try {
    const m = url.pathname.match(/^\/api\/orders\/(\d+)$/);
    if (url.pathname === '/health') return done(200, { ok: true });
    if (url.pathname === '/api/orders') {
      log('debug', `cache hit orders:list size=${orders.size}`);
      return done(200, [...orders.values()].map((o) => ({ id: o.id })));
    }
    if (m) {
      const order = orders.get(Number(m[1]));
      if (!order) return done(404, { error: 'not found' });
      log('debug', `cache hit order:${order.id}`);
      return done(200, { ...order, total: orderTotal(order) });
    }
    if (url.pathname === '/api/payments') {
      paymentsCalls++;
      if (paymentsCalls % 97 === 0) {
        log('warn', `payments upstream timeout after 3000ms (attempt ${paymentsCalls})`);
        return done(502, { error: 'upstream timeout' });
      }
      return done(200, { status: 'captured' });
    }
    return done(404, { error: 'not found' });
  } catch (err) {
    console.error(`${ts()} error unhandled exception in ${req.method} ${url.pathname}`);
    console.error(err.stack);
    return done(500, { error: 'internal' });
  }
});

server.listen(port, '127.0.0.1', () => {
  log('info', 'orders-api starting (NODE_ENV=development)');
  log('info', `Local: http://127.0.0.1:${port}`);
});
