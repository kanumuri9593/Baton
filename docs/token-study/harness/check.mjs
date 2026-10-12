// The script a competent agent writes (once) to verify a web change without Baton:
// load the page in headless Chromium, print console output, page errors, failed
// requests and the visible text, and save a phone-size screenshot.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:5175/';
const shot = process.argv[3] ?? '/tmp/shot.png';
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });
await page.goto(url, { waitUntil: 'networkidle' });
console.log('--- visible text ---');
console.log((await page.innerText('body')).trim() || '(empty page)');
await page.screenshot({ path: shot });
console.log(`screenshot: ${shot}`);
await browser.close();
