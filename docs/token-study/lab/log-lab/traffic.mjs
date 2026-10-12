// Deterministic traffic: 640 requests, the same sequence every run.
const base = process.argv[2] ?? 'http://127.0.0.1:43150';
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (let i = 0; i < 640; i++) {
  const r = rand();
  let path;
  if (r < 0.15) path = '/api/orders';
  else if (r < 0.70) path = `/api/orders/${1 + Math.floor(rand() * 40)}`;
  else if (r < 0.95) path = '/api/payments';
  else path = '/health';
  await fetch(base + path).then((res) => res.arrayBuffer());
}
console.log('traffic done');
