// Recount everything in raw/ from the saved files. No network needed.
//
// Text: cl100k_base (gpt-tokenizer 3.0.1) as the stated proxy, plus the legacy
// Claude tokenizer (@anthropic-ai/tokenizer 0.0.4, pre-Claude-3) as a cross-check.
// Neither is the tokenizer of current Claude models; treat figures as approximate.
// Images: Anthropic's published rule, one visual token per 28x28 patch,
// ceil(w/28) * ceil(h/28), after the model's resize (high-resolution tier for
// Claude 4.7 and later: 2576 px long edge, 4784 tokens; standard tier: 1568/1568).
// Source: https://platform.claude.com/docs/en/build-with-claude/vision (fetched 2026-10-11).
//
// Usage: node count.mjs [raw dir]   (env TOK = dir holding node_modules for the tokenizers)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RAW = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '../raw'));
const TOK = process.env.TOK ?? path.join(os.homedir(), 'baton-token-study/tools/tok');
const { encode } = await import(`${TOK}/node_modules/gpt-tokenizer/esm/encoding/cl100k_base.js`);
const { createRequire } = await import('node:module');
const legacy = createRequire(`${TOK}/package.json`)('@anthropic-ai/tokenizer');

const cl100k = (s) => (s ? encode(s).length : 0);
const claudeLegacy = (s) => (s ? legacy.countTokens(s) : 0);

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
const patches = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);
function roundTiesToEven(v) { const f = Math.floor(v); if (v - f !== 0.5) return Math.round(v); return f % 2 === 0 ? f : f + 1; }
function resized(w, h, maxEdge, maxTokens) {
  const fits = (a, b) => Math.ceil(a / 28) * 28 <= maxEdge && Math.ceil(b / 28) * 28 <= maxEdge && patches(a, b) <= maxTokens;
  if (fits(w, h)) return [w, h];
  if (h > w) { const [rh, rw] = resized(h, w, maxEdge, maxTokens); return [rw, rh]; }
  const ar = w / h; let lo = 1; let hi = w;
  while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); if (fits(mid, Math.max(roundTiesToEven(mid / ar), 1))) lo = mid; else hi = mid; }
  return [lo, Math.max(roundTiesToEven(lo / ar), 1)];
}
function imageTokens(file) {
  const { w, h } = pngSize(file);
  const hr = resized(w, h, 2576, 4784);
  const std = resized(w, h, 1568, 1568);
  return { file: path.relative(RAW, file), w, h, hr: patches(...hr), std: patches(...std), legacy750: Math.round((w * h) / 750) };
}

const calls = JSON.parse(fs.readFileSync(path.join(RAW, 'calls.json'), 'utf8'));
const rows = calls.map((c) => {
  const out = fs.readFileSync(path.join(RAW, c.out), 'utf8');
  const call = fs.readFileSync(path.join(RAW, c.call), 'utf8');
  const images = c.images.map((f) => imageTokens(path.join(RAW, f)));
  return {
    run: c.run, scenario: c.scenario, approach: c.approach, step: c.step, via: c.via,
    chars: out.length, lines: out ? out.split('\n').length : 0,
    text_cl100k: cl100k(out), text_claude_legacy: claudeLegacy(out),
    call_cl100k: cl100k(call),
    images,
    image_hr: images.reduce((a, i) => a + i.hr, 0),
    image_std: images.reduce((a, i) => a + i.std, 0),
  };
});

// Aggregate per run/scenario/approach.
const key = (r) => `${r.scenario}|${r.approach}`;
const agg = new Map();
for (const r of rows) {
  const k = `${key(r)}|${r.run}`;
  const a = agg.get(k) ?? { scenario: r.scenario, approach: r.approach, run: r.run, calls: 0, imageOnlyCalls: 0, chars: 0, text_cl100k: 0, text_claude_legacy: 0, call_cl100k: 0, image_hr: 0, image_std: 0, images: 0 };
  a.calls++; a.chars += r.chars; a.text_cl100k += r.text_cl100k; a.text_claude_legacy += r.text_claude_legacy;
  a.call_cl100k += r.call_cl100k; a.image_hr += r.image_hr; a.image_std += r.image_std; a.images += r.images.length;
  // A call that only exists to look at an image (Read of a PNG, a screenshot tool).
  if ((r.via === 'read' && r.images.length) || (/screenshot/.test(r.step) && r.approach.includes('playwright'))) a.imageOnlyCalls++;
  agg.set(k, a);
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const groups = new Map();
for (const a of agg.values()) {
  const k = `${a.scenario}|${a.approach}`;
  groups.set(k, [...(groups.get(k) ?? []), a]);
}
const summary = [...groups.values()].map((runs) => {
  const pick = (f) => ({ median: median(runs.map(f)), min: Math.min(...runs.map(f)), max: Math.max(...runs.map(f)) });
  return {
    scenario: runs[0].scenario, approach: runs[0].approach, runs: runs.length,
    calls: pick((r) => r.calls),
    calls_text_only: pick((r) => r.calls - r.imageOnlyCalls),
    chars: pick((r) => r.chars),
    text_cl100k: pick((r) => r.text_cl100k),
    text_claude_legacy: pick((r) => r.text_claude_legacy),
    image_hr: pick((r) => r.image_hr),
    image_std: pick((r) => r.image_std),
    total_hr: pick((r) => r.text_cl100k + r.image_hr),
    call_cl100k: pick((r) => r.call_cl100k),
    images: pick((r) => r.images),
  };
}).sort((a, b) => (a.scenario + a.approach).localeCompare(b.scenario + b.approach));

// Fixed per-session cost: MCP tool definitions the client loads into context.
const schemas = {};
const sdir = path.join(RAW, 'tool-schemas');
if (fs.existsSync(sdir)) {
  for (const f of fs.readdirSync(sdir)) {
    const tools = JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8'));
    const text = JSON.stringify(tools);
    const per = Object.fromEntries(tools.map((t) => [t.name, cl100k(JSON.stringify(t))]));
    schemas[f.replace('.tools.json', '')] = { tools: tools.length, chars: text.length, cl100k: cl100k(text), per_tool: per };
  }
}

// Per-step medians so a reader can see where the tokens come from.
const stepGroups = new Map();
for (const r of rows) {
  const k = `${r.scenario}|${r.approach}|${r.step}`;
  stepGroups.set(k, [...(stepGroups.get(k) ?? []), r]);
}
const steps = [...stepGroups.values()].map((rs) => ({
  scenario: rs[0].scenario, approach: rs[0].approach, step: rs[0].step,
  text_cl100k: median(rs.map((r) => r.text_cl100k)), chars: median(rs.map((r) => r.chars)),
  lines: median(rs.map((r) => r.lines)), image_hr: median(rs.map((r) => r.image_hr)),
  image_dims: rs[0].images.map((i) => `${i.w}x${i.h}`).join(' '),
}));

const result = { generated: new Date().toISOString(), tokenizer: 'cl100k_base via gpt-tokenizer@3.0.1 (proxy); legacy Claude tokenizer @anthropic-ai/tokenizer@0.0.4 as cross-check', summary, steps, schemas, rows };
fs.writeFileSync(path.join(RAW, '..', 'results.json'), JSON.stringify(result, null, 2));

const fmt = (p) => (p.min === p.max ? `${p.median}` : `${p.median} (${p.min}–${p.max})`);
let md = '| scenario | approach | tool calls | text tokens (cl100k) | text tokens (legacy Claude) | image tokens (hi-res tier) | total | agent-written call tokens | chars |\n|---|---|---|---|---|---|---|---|---|\n';
for (const s of summary) {
  md += `| ${s.scenario} | ${s.approach} | ${fmt(s.calls)} | ${fmt(s.text_cl100k)} | ${fmt(s.text_claude_legacy)} | ${fmt(s.image_hr)} | ${fmt(s.total_hr)} | ${fmt(s.call_cl100k)} | ${fmt(s.chars)} |\n`;
}
md += '\n| scenario | approach | step | median text tokens | median chars | median lines | image tokens | image size |\n|---|---|---|---|---|---|---|---|\n';
for (const s of steps) md += `| ${s.scenario} | ${s.approach} | ${s.step} | ${s.text_cl100k} | ${s.chars} | ${s.lines} | ${s.image_hr} | ${s.image_dims} |\n`;
md += '\n| MCP server | tools | schema chars | schema tokens (cl100k) |\n|---|---|---|---|\n';
for (const [k, v] of Object.entries(schemas)) md += `| ${k} | ${v.tools} | ${v.chars} | ${v.cl100k} |\n`;
fs.writeFileSync(path.join(RAW, '..', 'results-tables.md'), md);
console.log(md);
