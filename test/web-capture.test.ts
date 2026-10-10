import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser, webViewport } from '../src/daemon/capture.ts';
import { captureWithDevTools } from '../src/daemon/web-capture.ts';

const browser = findBrowser();

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('a phone capture is a real phone layout, and reports console errors and failed requests', { skip: !browser && 'no Chrome-family browser on this machine', timeout: 60_000 }, async () => {
  let reportedWidth = '';
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/width')) {
      reportedWidth = req.url.split('=')[1];
      res.end();
      return;
    }
    if (req.url === '/missing.png') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<meta name="viewport" content="width=device-width"><body style="margin:0;background:#4f46e5">' +
      '<img src="/missing.png"><script>fetch("/width?w=" + innerWidth)</script>' +
      '<script>console.error("cart total is NaN"); undefinedThing();</script></body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const path = join(mkdtempSync(join(tmpdir(), 'baton-web-')), 'phone.png');
    const evidence = await captureWithDevTools(browser!, `http://127.0.0.1:${port}/`, webViewport('phone'), path);
    assert.deepEqual(pngSize(path), { width: 780, height: 1688 });
    assert.equal(reportedWidth, '390');
    assert.ok(evidence, 'the page reports what went wrong on it');
    assert.ok(evidence.consoleErrors.some((e) => e.includes('cart total is NaN')), evidence.consoleErrors.join('\n'));
    assert.ok(evidence.consoleErrors.some((e) => e.includes('undefinedThing')), evidence.consoleErrors.join('\n'));
    assert.deepEqual(evidence.failedRequests, [`GET 404 http://127.0.0.1:${port}/missing.png`]);
  } finally {
    server.close();
  }
});
