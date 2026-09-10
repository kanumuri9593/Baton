import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const api = process.env.API_URL ?? 'http://127.0.0.1:43121';
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    try {
      const upstream = await fetch(api + req.url.slice(4), { method: req.method, signal: AbortSignal.timeout(3000) });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(await upstream.text());
    } catch {
      console.error('API_UNAVAILABLE: delivery service is not reachable');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Delivery service is offline. Start the API and retry.' }));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(readFileSync(new URL('./index.html', import.meta.url)));
});
// Print the port the OS actually bound, not the one that was asked for: with
// PORT=0 those differ, and a URL nobody can open is worse than none.
server.listen(Number(process.env.PORT ?? 43122), '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}`));
