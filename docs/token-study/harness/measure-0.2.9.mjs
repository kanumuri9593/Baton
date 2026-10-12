// Token study harness, as run for the baton-run 0.2.9 baseline (includes scenario 4).
// Token study harness: runs each scenario WITH Baton (MCP + CLI) and WITHOUT it
// (shell + a Playwright script, and Playwright MCP), and saves the exact text and
// images each approach would put into an agent's context. It does not count
// tokens; count.mjs does that from the saved files, so anyone can recount.
//
// Env: TOOLS (tool installs), PROJ (where the labs are copied), LAB (lab
// templates), OUT (raw output dir), RUNS (default 3), CHROME (browser binary).
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOLS = process.env.TOOLS ?? path.join(os.homedir(), 'baton-token-study/tools');
const PROJ = process.env.PROJ ?? path.join(os.homedir(), 'baton-token-study/projects');
const LAB = process.env.LAB ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../lab');
const OUT = process.env.OUT ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../baseline-0.2.9/raw');
const RUNS = Number(process.env.RUNS ?? 3);
const CHROME = process.env.CHROME ?? '/usr/local/bin/chromium';
const WORKFLOW_LAB = process.env.WORKFLOW_LAB ?? execSync('npm root -g', { encoding: 'utf8' }).trim() + '/baton-run/examples/workflow-lab';

const sdk = `${TOOLS}/pwmcp/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${sdk}/client/index.js`);
const { StdioClientTransport } = await import(`${sdk}/client/stdio.js`);

const A = `${PROJ}/A`; // WITH Baton
const B = `${PROJ}/B`; // WITHOUT Baton
const WEB_A = 'http://127.0.0.1:5174/';
const WEB_B = 'http://127.0.0.1:5175/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, CHROME, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

const calls = [];
let ctx = { run: 0, scenario: '', approach: '' };
let stepNo = 0;
const setCtx = (scenario, approach) => { ctx = { ...ctx, scenario, approach }; stepNo = 0; };
function base(step) {
  stepNo++;
  const dir = `${OUT}/run-${ctx.run}/${ctx.scenario}/${ctx.approach}`;
  fs.mkdirSync(dir, { recursive: true });
  return `${dir}/${String(stepNo).padStart(2, '0')}-${step}`;
}
const rel = (p) => path.relative(OUT, p);

function sh(cmd, cwd, opts = {}) {
  try {
    return execSync(`${cmd} 2>&1`, { cwd, shell: '/bin/bash', encoding: 'utf8', env, maxBuffer: 64 << 20, timeout: 180000, ...opts });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

/** A shell command as an agent would run it through its Bash tool; the output is what enters context. */
function bashStep(step, cmd, cwd) {
  const out = sh(cmd, cwd);
  const b = base(step);
  const call = `Bash ${JSON.stringify({ command: cmd })}`;
  fs.writeFileSync(`${b}.call.txt`, call);
  fs.writeFileSync(`${b}.out.txt`, out);
  calls.push({ ...ctx, step: `${String(stepNo).padStart(2, '0')}-${step}`, via: 'bash', cwd, call: rel(`${b}.call.txt`), out: rel(`${b}.out.txt`), images: [] });
  return out;
}

/** The agent opening a PNG with its file-read tool: only the image enters context. */
function readImageStep(step, file) {
  const b = base(step);
  const call = `Read ${JSON.stringify({ file_path: file })}`;
  fs.writeFileSync(`${b}.call.txt`, call);
  fs.writeFileSync(`${b}.out.txt`, '');
  fs.copyFileSync(file, `${b}.img-1.png`);
  calls.push({ ...ctx, step: `${String(stepNo).padStart(2, '0')}-${step}`, via: 'read', call: rel(`${b}.call.txt`), out: rel(`${b}.out.txt`), images: [rel(`${b}.img-1.png`)] });
}

/** The agent opening a text file with its file-read tool (e.g. a snapshot another tool saved). */
function readTextStep(step, file) {
  const b = base(step);
  fs.writeFileSync(`${b}.call.txt`, `Read ${JSON.stringify({ file_path: file })}`);
  fs.writeFileSync(`${b}.out.txt`, fs.readFileSync(file, 'utf8'));
  calls.push({ ...ctx, step: `${String(stepNo).padStart(2, '0')}-${step}`, via: 'read', call: rel(`${b}.call.txt`), out: rel(`${b}.out.txt`), images: [] });
}

/** Playwright MCP 0.0.8x saves the page snapshot to a file; reading the page means opening it. */
async function pwNavigate(pw, step, url) {
  const out = await mcpStep(pw, `navigate${step}`, 'browser_navigate', { url });
  const snap = /\[Snapshot\]\(([^)]+)\)/.exec(out)?.[1];
  if (snap) readTextStep(`read-snapshot${step}`, path.resolve(`${B}/web-lab`, snap));
}

async function mcpStep(client, step, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  const b = base(step);
  fs.writeFileSync(`${b}.call.txt`, `${name} ${JSON.stringify(args)}`);
  const texts = [];
  const images = [];
  for (const c of result.content ?? []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image') {
      const f = `${b}.img-${images.length + 1}.png`;
      fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
      images.push(rel(f));
    } else texts.push(JSON.stringify(c));
  }
  fs.writeFileSync(`${b}.out.txt`, texts.join('\n'));
  calls.push({ ...ctx, step: `${String(stepNo).padStart(2, '0')}-${step}`, via: 'mcp', call: rel(`${b}.call.txt`), out: rel(`${b}.out.txt`), images, isError: !!result.isError });
  return texts.join('\n');
}

async function connect(command, args, extraEnv = {}, cwd = undefined) {
  const client = new Client({ name: 'token-study', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command, args, cwd, env: { ...env, ...extraEnv }, stderr: 'ignore' }));
  return client;
}

// ---- edits (identical on both sides) --------------------------------------
const TEXTS = ['Arriving today', 'Driver nearby', 'Delivered soon', 'On the way now', 'Next stop: you', 'Out for delivery'];
let textIdx = 0;
function setBanner(dir, text) {
  const f = `${dir}/web-lab/src/App.jsx`;
  const src = fs.readFileSync(f, 'utf8').replace(/const banner = '[^']*';/, `const banner = '${text}';`);
  fs.writeFileSync(f, src);
}
function breakBanner(dir) {
  const f = `${dir}/web-lab/src/App.jsx`;
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('{banner}', '{bannr}'));
}
function fixBanner(dir) {
  const f = `${dir}/web-lab/src/App.jsx`;
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('{bannr}', '{banner}'));
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').length : 1);

// ---- processes for the WITHOUT side ---------------------------------------
const bProcs = [];
function startB(cmd, cwd, logFile, extraEnv = {}) {
  const fd = fs.openSync(logFile, 'w');
  const p = spawn('/bin/bash', ['-c', cmd], { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', fd, fd], detached: true });
  bProcs.push(p);
  return p;
}
async function waitHttp(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); await r.arrayBuffer(); return; } catch { await sleep(200); }
  }
  throw new Error(`timeout waiting for ${url}`);
}
function killB() {
  for (const p of bProcs.splice(0)) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }
}

const B_PORTS = '5175/tcp 43150/tcp 43141/tcp 43142/tcp';
function freshLabs() {
  sh('baton stop --all; baton forget --all');
  sh(`fuser -k ${B_PORTS}; true`);
  for (const side of [A, B]) {
    fs.rmSync(side, { recursive: true, force: true });
    fs.mkdirSync(side, { recursive: true });
    sh(`cp -r "${LAB}/web-lab" "${side}/web-lab" && cp -r "${TOOLS}/web-node_modules" "${side}/web-lab/node_modules"`);
    sh(`cp -r "${LAB}/log-lab" "${side}/orders-api"`);
    sh(`cp -r "${WORKFLOW_LAB}" "${side}/workflow-lab"`);
  }
}

// ---- one run ----------------------------------------------------------------
async function run(n) {
  ctx.run = n;
  console.log(`\n=== run ${n} ===`);
  freshLabs();

  const baton = await connect('baton-mcp', []);
  const pw = await connect(process.execPath, [
    `${TOOLS}/pwmcp/node_modules/@playwright/mcp/cli.js`, '--headless', '--isolated',
    '--executable-path', CHROME, '--viewport-size', '390x844', '--no-sandbox',
  ], {}, `${B}/web-lab`);
  if (n === 1) {
    fs.mkdirSync(`${OUT}/tool-schemas`, { recursive: true });
    fs.writeFileSync(`${OUT}/tool-schemas/baton-mcp.tools.json`, JSON.stringify((await baton.listTools()).tools));
    fs.writeFileSync(`${OUT}/tool-schemas/playwright-mcp.tools.json`, JSON.stringify((await pw.listTools()).tools));
  }

  // Start both web labs (not measured: both sides need a running dev server).
  const started = await baton.callTool({ name: 'run_target', arguments: { cwd: `${A}/web-lab`, target: 'Web lab' } });
  const webA = /([\w.-]+\/web-lab)/.exec(started.content[0].text)?.[1] ?? 'A/web-lab';
  await baton.callTool({ name: 'wait_for', arguments: { session: webA, until: 'url', timeoutMs: 60000 } });
  const devLog = `${B}/web-lab/dev.log`;
  startB('npm run dev', `${B}/web-lab`, devLog, { PORT: '5175' });
  await waitHttp(WEB_B);
  // Warm-up, not measured: first page load optimises deps on both sides.
  await baton.callTool({ name: 'check_change', arguments: { session: webA, action: 'none', viewport: 'phone' } }, undefined, { timeout: 120000 });
  sh(`node check.mjs ${WEB_B} /tmp/shot-B.png`, `${TOOLS}/pw`);
  await pw.callTool({ name: 'browser_navigate', arguments: { url: WEB_B } });

  const check = (shot) => `node check.mjs ${WEB_B} ${shot}`;
  const PWDIR = `${TOOLS}/pw`;

  // ---- Scenario 1: happy-path UI text edit ---------------------------------
  const S1 = 's1-happy-edit';
  textIdx = 0;
  setCtx(S1, 'with-baton-mcp'); setBanner(A, TEXTS[textIdx++ % TEXTS.length]);
  await mcpStep(baton, 'check_change', 'check_change', { session: webA, viewport: 'phone' });
  setCtx(S1, 'with-baton-mcp-noshot'); setBanner(A, TEXTS[textIdx++ % TEXTS.length]);
  await mcpStep(baton, 'check_change', 'check_change', { session: webA, viewport: 'phone', screenshot: false });
  setCtx(S1, 'with-baton-cli'); setBanner(A, TEXTS[textIdx++ % TEXTS.length]);
  bashStep('baton-check', `baton check ${webA} --viewport phone --json`, `${A}/web-lab`);

  textIdx = 0;
  setCtx(S1, 'without-script'); setBanner(B, TEXTS[textIdx++ % TEXTS.length]); await sleep(300);
  bashStep('check-script', check('/tmp/shot-B.png'), PWDIR);
  readImageStep('read-screenshot', '/tmp/shot-B.png');
  setCtx(S1, 'without-playwright-mcp'); setBanner(B, TEXTS[textIdx++ % TEXTS.length]); await sleep(300);
  await pwNavigate(pw, '', WEB_B);
  await mcpStep(pw, 'console', 'browser_console_messages', {});
  await mcpStep(pw, 'screenshot', 'browser_take_screenshot', {});
  setCtx(S1, 'without-typical-shell'); let k = lines(devLog); setBanner(B, TEXTS[textIdx++ % TEXTS.length]); await sleep(300);
  bashStep('dev-server-output', `tail -n +${k} ${devLog}`, `${B}/web-lab`);
  bashStep('curl-page', `curl -s ${WEB_B}`, `${B}/web-lab`);
  bashStep('check-script', check('/tmp/shot-B.png'), PWDIR);
  readImageStep('read-screenshot', '/tmp/shot-B.png');

  // ---- Scenario 2: broken edit, discover, fix, confirm -----------------------
  const S2 = 's2-broken-edit';
  setCtx(S2, 'with-baton-mcp'); breakBanner(A);
  await mcpStep(baton, 'check_change-broken', 'check_change', { session: webA, viewport: 'phone' });
  fixBanner(A);
  await mcpStep(baton, 'check_change-fixed', 'check_change', { session: webA, viewport: 'phone' });
  setCtx(S2, 'with-baton-mcp-noshot'); breakBanner(A);
  await mcpStep(baton, 'check_change-broken', 'check_change', { session: webA, viewport: 'phone', screenshot: false });
  fixBanner(A);
  await mcpStep(baton, 'check_change-fixed', 'check_change', { session: webA, viewport: 'phone', screenshot: false });
  setCtx(S2, 'with-baton-cli'); breakBanner(A);
  bashStep('baton-check-broken', `baton check ${webA} --viewport phone --json`, `${A}/web-lab`);
  fixBanner(A);
  bashStep('baton-check-fixed', `baton check ${webA} --viewport phone --json`, `${A}/web-lab`);

  setCtx(S2, 'without-script'); breakBanner(B); await sleep(300);
  bashStep('check-script-broken', check('/tmp/shot-B.png'), PWDIR);
  readImageStep('read-screenshot-broken', '/tmp/shot-B.png');
  fixBanner(B); await sleep(300);
  bashStep('check-script-fixed', check('/tmp/shot-B.png'), PWDIR);
  readImageStep('read-screenshot-fixed', '/tmp/shot-B.png');
  setCtx(S2, 'without-playwright-mcp'); breakBanner(B); await sleep(300);
  await pwNavigate(pw, '-broken', WEB_B);
  await mcpStep(pw, 'console-broken', 'browser_console_messages', {});
  await mcpStep(pw, 'screenshot-broken', 'browser_take_screenshot', {});
  fixBanner(B); await sleep(300);
  await pwNavigate(pw, '-fixed', WEB_B);
  await mcpStep(pw, 'console-fixed', 'browser_console_messages', {});
  await mcpStep(pw, 'screenshot-fixed', 'browser_take_screenshot', {});
  setCtx(S2, 'without-typical-shell'); k = lines(devLog); breakBanner(B); await sleep(300);
  bashStep('dev-server-output-broken', `tail -n +${k} ${devLog}`, `${B}/web-lab`);
  bashStep('curl-page-broken', `curl -s ${WEB_B}`, `${B}/web-lab`);
  bashStep('check-script-broken', check('/tmp/shot-B.png'), PWDIR);
  readImageStep('read-screenshot-broken', '/tmp/shot-B.png');
  k = lines(devLog); fixBanner(B); await sleep(300);
  bashStep('dev-server-output-fixed', `tail -n +${k} ${devLog}`, `${B}/web-lab`);
  bashStep('check-script-fixed', check('/tmp/shot-B.png'), PWDIR);
  readImageStep('read-screenshot-fixed', '/tmp/shot-B.png');

  // ---- Scenario 3: find the error in a long service log ----------------------
  const S3 = 's3-log-debugging';
  const ordersStarted = await baton.callTool({ name: 'run_target', arguments: { cwd: `${A}/orders-api`, target: 'Orders API' } });
  const ordersA = /([\w.-]+\/orders-api)/.exec(ordersStarted.content[0].text)?.[1] ?? 'A/orders-api';
  await baton.callTool({ name: 'wait_for', arguments: { session: ordersA, until: 'url', timeoutMs: 60000 } });
  const serverLog = `${B}/orders-api/server.log`;
  startB('node server.mjs', `${B}/orders-api`, serverLog, { PORT: '43150' });
  await waitHttp('http://127.0.0.1:43150/health');
  sh('node traffic.mjs http://127.0.0.1:43151', `${A}/orders-api`);
  sh('node traffic.mjs http://127.0.0.1:43150', `${B}/orders-api`);
  await sleep(1000);
  setCtx(S3, 'with-baton-diagnose');
  await mcpStep(baton, 'diagnose', 'diagnose', { sessions: [ordersA] });
  setCtx(S3, 'with-baton-read_logs-filter');
  await mcpStep(baton, 'read_logs', 'read_logs', { session: ordersA, filter: 'error|exception', tail: 5000 });
  setCtx(S3, 'without-tail-200');
  bashStep('tail', `tail -n 200 ${serverLog}`, `${B}/orders-api`);
  setCtx(S3, 'without-grep');
  bashStep('grep', `grep -n -i -E "error|exception" -A 6 ${serverLog}`, `${B}/orders-api`);
  setCtx(S3, 'without-whole-log');
  bashStep('cat', `cat ${serverLog}`, `${B}/orders-api`);
  fs.mkdirSync(`${OUT}/run-${n}/${S3}`, { recursive: true });
  fs.writeFileSync(`${OUT}/run-${n}/${S3}/log-line-count.txt`, `${lines(serverLog) - 1}\n`);

  // ---- Scenario 4: start a two-service workflow ------------------------------
  const S4 = 's4-workflow-startup';
  setCtx(S4, 'with-baton-run_workflow');
  await mcpStep(baton, 'run_workflow', 'run_workflow', {
    name: 'Delivery end-to-end',
    steps: [
      { name: 'API', cwd: `${A}/workflow-lab/api`, target: 'Delivery API', until: 'url' },
      { name: 'Console', cwd: `${A}/workflow-lab/console`, target: 'Delivery console', until: 'url' },
    ],
  });
  // WITHOUT, lean: one command that starts both in the background and waits for them.
  setCtx(S4, 'without-one-command');
  const W = `${B}/workflow-lab`;
  bashStep('start-and-wait', [
    '(cd api && PORT=43141 APP_ENV="Local lab" node server.mjs) > api.log 2>&1 &',
    'until curl -sf -o /dev/null http://127.0.0.1:43141/delivery; do sleep 0.2; done',
    '(cd console && PORT=43142 APP_ENV="Local lab" API_URL=http://127.0.0.1:43141 node server.mjs) > console.log 2>&1 &',
    'until curl -sf -o /dev/null http://127.0.0.1:43142/; do sleep 0.2; done',
    'cat api.log console.log',
  ].join('\n'), W);
  sh('fuser -k 43141/tcp 43142/tcp; true');
  await sleep(500);
  // WITHOUT, step by step: start, poll, start, poll.
  setCtx(S4, 'without-step-by-step');
  bashStep('start-api', `(cd api && PORT=43141 APP_ENV="Local lab" node server.mjs) > api.log 2>&1 & sleep 1; cat api.log`, W);
  bashStep('poll-api', `curl -s http://127.0.0.1:43141/delivery`, W);
  bashStep('start-console', `(cd console && PORT=43142 APP_ENV="Local lab" API_URL=http://127.0.0.1:43141 node server.mjs) > console.log 2>&1 & sleep 1; cat console.log`, W);
  bashStep('poll-console', `curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:43142/`, W);
  sh('fuser -k 43141/tcp 43142/tcp; true');

  // ---- cleanup ---------------------------------------------------------------
  killB();
  sh(`fuser -k ${B_PORTS}; true`);
  await baton.callTool({ name: 'stop_session', arguments: { all: true } });
  await baton.callTool({ name: 'forget_session', arguments: { all: true } });
  await pw.close();
  await baton.close();
}

fs.mkdirSync(OUT, { recursive: true });
try {
  for (let i = 1; i <= RUNS; i++) await run(i);
} finally {
  killB();
  fs.writeFileSync(`${OUT}/calls.json`, JSON.stringify(calls, null, 2));
}
console.log(`\nsaved ${calls.length} calls to ${OUT}/calls.json`);
