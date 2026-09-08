import { createServer } from 'node:http';
import { Delivery } from './delivery.mjs';
const delivery = new Delivery();
const server = createServer((req, res) => {
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url === '/health') return send(200, { ready: true });
  if (req.url === '/delivery' && req.method === 'GET') return send(200, { ...delivery.snapshot(), environment: process.env.APP_ENV ?? 'Local' });
  if (req.url === '/delivery/complete' && req.method === 'POST') {
    const receipt = delivery.complete();
    console.log('delivery.completed DEMO-1042');
    return send(200, receipt);
  }
  if (req.url === '/delivery/reset' && req.method === 'POST') { return send(200, delivery.reset()); }
  send(404, { error: 'Not found' });
});
server.listen(Number(process.env.PORT ?? 43121), '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}`));
