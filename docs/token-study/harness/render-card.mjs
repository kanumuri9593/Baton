// Render token-savings.png (1080x1350) and token-savings-1200x627.png from a results.json.
// Bars are totals an agent reads (tool-output text + screenshot image tokens), medians of the runs.
// Savings are rounded down, so the card never overstates.
// Usage: node render-card.mjs [results.json] [out-dir]
//   defaults: ../results.json (the 0.2.10 run); out-dir = ..
//   env PW = dir with node_modules/playwright, CHROME = browser binary
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const PW = process.env.PW ?? path.join(os.homedir(), 'baton-token-study/tools/pw');
const { chromium } = createRequire(`${PW}/package.json`)('playwright');
const RESULTS = path.resolve(process.argv[2] ?? path.join(ROOT, 'results.json'));
const OUT = path.resolve(process.argv[3] ?? ROOT);
const R = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
const get = (scenario, approach) => R.summary.find((s) => s.scenario === scenario && s.approach === approach);
const tot = (s, a) => get(s, a).total_hr.median;
const txt = (s, a) => get(s, a).text_cl100k.median;
const c = (s, a) => get(s, a).calls.median;
const save = (a, b) => Math.floor((1 - a / b) * 100);
const row = (s, a) => ({ v: tot(s, a), text: txt(s, a), calls: c(s, a) });
const S1 = 's1-happy-edit', S2 = 's2-broken-edit', S3 = 's3-log-debugging';
const DATA = {
  s1: { baton: row(S1, 'with-baton-mcp'), pwmcp: row(S1, 'without-playwright-mcp'), script: row(S1, 'without-script'), shell: row(S1, 'without-typical-shell') },
  s2: { baton: row(S2, 'with-baton-mcp'), pwmcp: row(S2, 'without-playwright-mcp'), script: row(S2, 'without-script'), shell: row(S2, 'without-typical-shell') },
  s3: { diagnose: tot(S3, 'with-baton-diagnose'), grep: tot(S3, 'without-grep'), tail: tot(S3, 'without-tail-200'), cat: tot(S3, 'without-whole-log') },
  img: { baton: get(S1, 'with-baton-mcp').image_hr.median, script: get(S1, 'without-script').image_hr.median },
  schema: Object.fromEntries([['baton', 'baton-mcp'], ['pwmcp', 'playwright-mcp']].map(([k, n]) => [k, { tools: R.schemas[n].tools, cl100k: R.schemas[n].cl100k }])),
  logLines: Number(fs.readFileSync(path.join(path.dirname(RESULTS), 'raw/run-1/s3-log-debugging/without-whole-log/01-cat.out.txt'), 'utf8').trimEnd().split('\n').length),
};
// Each panel's percentage is against its cheapest baseline.
DATA.s1pct = save(DATA.s1.baton.v, DATA.s1.pwmcp.v);
DATA.s2pct = save(DATA.s2.baton.v, DATA.s2.pwmcp.v);
DATA.s3pct = save(DATA.s3.diagnose, DATA.s3.grep);
console.log(JSON.stringify(DATA, null, 2));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
for (const [layout, w, h, file] of [['portrait', 1080, 1350, 'token-savings.png'], ['landscape', 1200, 627, 'token-savings-1200x627.png']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.addInitScript((d) => { window.DATA = d; }, DATA);
  await page.goto(`file://${HERE}/card.html?layout=${layout}`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.evaluate(() => document.fonts.ready);
  const over = await page.evaluate(() => document.querySelector('.foot').getBoundingClientRect().bottom - (innerHeight - 24));
  if (over > 0) console.error(`warning: ${file} footer is within 24px of the edge or past it, by ${Math.ceil(over)}px`);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
}
await browser.close();
