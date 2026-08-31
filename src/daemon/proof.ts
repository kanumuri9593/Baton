import { execFile, execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { Bootable } from './simulators.ts';
import type { Device } from './devices.ts';
import type { Target } from '../config/detect.ts';
import type { LogLine, NetworkRequestSnapshot, Session } from '../core/types.ts';
import { proofsDir } from '../core/paths.ts';

/** Built-in assertions a proof cell can enforce. */
export const PROOF_CHECK_NAMES = ['running', 'noErrors', 'noFailedRequests', 'screenshot'] as const;
export type ProofCheckName = (typeof PROOF_CHECK_NAMES)[number];

const DEFAULT_CHECKS: ProofCheckName[] = ['running', 'noErrors', 'noFailedRequests', 'screenshot'];
const DEFAULT_SETTLE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_SCREENSHOT_BYTES = 1024;

export type ProofCellSpec = {
  id: string;
  deviceId: string;
  deviceName: string;
  platformType: string;
  appearance?: 'light' | 'dark';
  textScale?: number;
  locale?: string;
};

export type CheckOutcome = { pass: boolean; message?: string };

export type ProofCellResult = {
  spec: ProofCellSpec;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'error';
  sessionId?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  checks: Partial<Record<ProofCheckName, CheckOutcome>>;
  screenshotPath?: string;
  error?: string;
};

export type ProofRunParams = {
  target: string;
  cwd?: string;
  devices?: string[];
  appearance?: ('light' | 'dark')[];
  textScale?: number[];
  locale?: string[];
  route?: string;
  checks?: ProofCheckName[];
  allow?: string[];
  keep?: boolean;
  out?: string;
  settleMs?: number;
  timeoutMs?: number;
};

export type ProofRunSummary = {
  id: string;
  target: string;
  root: string;
  startedAt: number;
  finishedAt: number;
  passed: boolean;
  git?: { sha?: string; dirty?: boolean };
  cells: ProofCellResult[];
  bundlePath: string;
  /** Populated after packaging — the shareable deliverable. */
  zipPath?: string;
};

/** Per-endpoint rollup for one cell or the whole proof run. */
export type NetworkEndpointStat = {
  endpoint: string;
  method: string;
  path: string;
  count: number;
  failed: number;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  statusCodes: Record<string, number>;
};

export type CellNetworkSummary = {
  cell: string;
  label: string;
  totalRequests: number;
  failedRequests: number;
  endpoints: NetworkEndpointStat[];
};

export type ProofListEntry = {
  id: string;
  target: string;
  root: string;
  startedAt: number;
  finishedAt: number;
  passed: boolean;
  cellCount: number;
  bundlePath: string;
  zipPath?: string;
};

export type ProofProgressEvent = {
  proofId: string;
  cell: string;
  /** Human label, e.g. "iPhone 17 Pro · light". */
  label?: string;
  current?: number;
  total?: number;
  phase?: 'boot' | 'cell' | 'packaging' | 'done';
  status: 'starting' | 'running' | 'passed' | 'failed' | 'error';
  message?: string;
};

/** Human-readable label for progress output. */
export function formatCellLabel(spec: ProofCellSpec): string {
  const parts = [spec.deviceName];
  if (spec.appearance) parts.push(spec.appearance);
  if (spec.textScale !== undefined && spec.textScale !== 1) parts.push(`${spec.textScale}x`);
  if (spec.locale) parts.push(spec.locale);
  return parts.join(' · ');
}

/** Normalize a request URI to a path for grouping (query strings stripped). */
export function requestPath(uri: string): string {
  try {
    return new URL(uri).pathname;
  } catch {
    return uri.split('?')[0] ?? uri;
  }
}

/** Roll up captured traffic: call counts, response times, status codes per endpoint. */
export function summarizeNetwork(requests: NetworkRequestSnapshot[]): NetworkEndpointStat[] {
  const groups = new Map<string, { method: string; path: string; rows: NetworkRequestSnapshot[] }>();
  for (const row of requests) {
    if (row.inProgress) continue;
    const path = requestPath(row.uri);
    const key = `${row.method} ${path}`;
    const group = groups.get(key) ?? { method: row.method, path, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  const stats: NetworkEndpointStat[] = [];
  for (const [endpoint, { method, path, rows }] of groups) {
    const durations = rows.map((r) => r.durationMs).filter((d): d is number => d !== undefined);
    const statusCodes: Record<string, number> = {};
    let failed = 0;
    for (const row of rows) {
      if (row.error || (row.statusCode !== undefined && row.statusCode >= 400)) failed++;
      if (row.statusCode !== undefined) {
        const code = String(row.statusCode);
        statusCodes[code] = (statusCodes[code] ?? 0) + 1;
      }
    }
    stats.push({
      endpoint,
      method,
      path,
      count: rows.length,
      failed,
      avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      minMs: durations.length ? Math.min(...durations) : null,
      maxMs: durations.length ? Math.max(...durations) : null,
      statusCodes,
    });
  }
  return stats.sort((a, b) => b.count - a.count);
}

function networkSummaryText(stats: NetworkEndpointStat[]): string[] {
  if (!stats.length) return ['(no HTTP traffic captured)'];
  const lines = ['| Endpoint | Calls | Failed | Avg ms | Min | Max |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const row of stats) {
    lines.push(
      `| \`${row.endpoint}\` | ${row.count} | ${row.failed} | ${row.avgMs ?? '—'} | ${row.minMs ?? '—'} | ${row.maxMs ?? '—'} |`,
    );
  }
  return lines;
}

/** Injectable zip seam — tests skip shelling out to `zip`. */
export type ZipFn = (bundlePath: string, zipPath: string) => Promise<void>;

export const defaultZip: ZipFn = (bundlePath, zipPath) =>
  new Promise((resolve, reject) => {
    execFile('zip', ['-rq', zipPath, basename(bundlePath)], { cwd: dirname(bundlePath) }, (err) => {
      if (err) reject(new Error(`zip failed: ${err.message}`));
      else resolve();
    });
  });

/** Package a proof directory into a single `.zip` next to it. */
export async function zipProofBundle(bundlePath: string, zipFn: ZipFn = defaultZip): Promise<string> {
  const zipPath = `${bundlePath}.zip`;
  await zipFn(bundlePath, zipPath);
  return zipPath;
}
export type CellExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;

export const defaultCellExec: CellExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, _stdout, stderr) => {
      resolve({ code: err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as any).code : 1) : 0, stderr: stderr || (err?.message ?? '') });
    });
  });

/** Split a comma-separated CLI flag into trimmed tokens; undefined/empty → undefined. */
export function parseAxisList(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

/** Parse appearance axis values, rejecting unknown tokens. */
export function parseAppearanceList(raw?: string): ('light' | 'dark')[] | undefined {
  const list = parseAxisList(raw);
  if (!list) return undefined;
  for (const item of list) {
    if (item !== 'light' && item !== 'dark') {
      throw new Error(`appearance must be light or dark (got "${item}")`);
    }
  }
  return list as ('light' | 'dark')[];
}

/** Parse numeric text-scale axis. */
export function parseTextScaleList(raw?: string): number[] | undefined {
  const list = parseAxisList(raw);
  if (!list) return undefined;
  return list.map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid text scale "${s}"`);
    return n;
  });
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

/** Stable directory name for one matrix cell. */
export function cellId(spec: Pick<ProofCellSpec, 'deviceName' | 'appearance' | 'textScale' | 'locale'>): string {
  const parts = [
    slugPart(spec.deviceName),
    spec.appearance ?? 'default',
    spec.textScale !== undefined ? String(spec.textScale) : '1',
    spec.locale ? slugPart(spec.locale) : 'default',
  ];
  return parts.join('-');
}

/** Exact name/id, then case-insensitive substring — same rule as targets and devices. */
export function pickNamed<T extends { name: string; id: string }>(items: T[], query: string): T | undefined {
  const exact = items.find((d) => d.name === query || d.id === query);
  if (exact) return exact;
  const lower = query.toLowerCase();
  const matches = items.filter((d) => d.name.toLowerCase().includes(lower));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Resolve one device query against connected devices, then bootables. */
export function resolveDeviceQuery(
  query: string,
  connected: Device[],
  bootables: Bootable[],
): { deviceId: string; deviceName: string; platformType: string; needsBoot: boolean } {
  const hit = pickNamed(connected, query);
  if (hit) return { deviceId: hit.id, deviceName: hit.name, platformType: hit.platformType, needsBoot: false };

  const bootable = pickNamed(bootables, query);
  if (!bootable) {
    const candidates = [...connected, ...bootables].map((d) => d.name);
    throw new Error(
      `no device matching "${query}"` +
        (candidates.length ? ` — try one of:\n  ${candidates.join('\n  ')}` : ''),
    );
  }
  return {
    deviceId: bootable.id,
    deviceName: bootable.name,
    platformType: bootable.platformType,
    needsBoot: !bootable.running,
  };
}

type DevicePick = { deviceId: string; deviceName: string; platformType: string; needsBoot: boolean };

/**
 * Expand the proof matrix: devices × appearance × text scale × locale.
 *
 * Pure aside from the device-resolution inputs — the orchestrator supplies
 * connected/bootable lists and handles booting anything with `needsBoot`.
 */
export function expandProofMatrix(
  params: {
    devices?: string[];
    appearance?: ('light' | 'dark')[];
    textScale?: number[];
    locale?: string[];
  },
  connected: Device[],
  bootables: Bootable[],
): { cells: ProofCellSpec[]; boots: DevicePick[] } {
  const appearances = params.appearance?.length ? params.appearance : [undefined] as const;
  const scales = params.textScale?.length ? params.textScale : [undefined] as const;
  const locales = params.locale?.length ? params.locale : [undefined] as const;

  let picks: DevicePick[];
  if (params.devices?.length) {
    picks = params.devices.map((q) => resolveDeviceQuery(q, connected, bootables));
  } else {
    const first = connected[0];
    if (first) {
      picks = [{ deviceId: first.id, deviceName: first.name, platformType: first.platformType, needsBoot: false }];
    } else {
      const booted = bootables.find((b) => b.running);
      if (!booted) {
        throw new Error('no connected device — pass --devices or boot a simulator first (baton boot "<name>")');
      }
      picks = [{
        deviceId: booted.id,
        deviceName: booted.name,
        platformType: booted.platformType,
        needsBoot: false,
      }];
    }
  }

  const cells: ProofCellSpec[] = [];
  for (const pick of picks) {
    for (const appearance of appearances) {
      for (const textScale of scales) {
        for (const locale of locales) {
          const spec: ProofCellSpec = {
            id: '',
            deviceId: pick.deviceId,
            deviceName: pick.deviceName,
            platformType: pick.platformType,
            appearance: appearance as 'light' | 'dark' | undefined,
            textScale: textScale as number | undefined,
            locale: locale as string | undefined,
          };
          spec.id = cellId(spec);
          cells.push(spec);
        }
      }
    }
  }
  return { cells, boots: picks.filter((p) => p.needsBoot) };
}

/** Map a numeric scale to the nearest iOS Simulator content-size bucket. */
export function textScaleToIosContentSize(scale: number): string {
  if (scale <= 0.85) return 'small';
  if (scale <= 1.0) return 'medium';
  if (scale <= 1.15) return 'large';
  if (scale <= 1.3) return 'extra-large';
  if (scale <= 1.5) return 'extra-extra-large';
  return 'accessibility-extra-extra-extra-large';
}

export async function applyCellSettings(spec: ProofCellSpec, exec: CellExecFn = defaultCellExec): Promise<void> {
  if (spec.platformType === 'ios') {
    if (spec.appearance) {
      const r = await exec('xcrun', ['simctl', 'ui', spec.deviceId, 'appearance', spec.appearance]);
      if (r.code !== 0) throw new Error(`simctl appearance failed: ${r.stderr}`);
    }
    if (spec.textScale !== undefined) {
      const size = textScaleToIosContentSize(spec.textScale);
      const r = await exec('xcrun', ['simctl', 'ui', spec.deviceId, 'content_size', size]);
      if (r.code !== 0) throw new Error(`simctl content_size failed: ${r.stderr}`);
    }
    return;
  }
  if (spec.platformType === 'android') {
    if (spec.appearance) {
      const mode = spec.appearance === 'dark' ? 'yes' : 'no';
      const r = await exec('adb', ['-s', spec.deviceId, 'shell', 'cmd', 'uimode', 'night', mode]);
      if (r.code !== 0) throw new Error(`adb uimode night failed: ${r.stderr}`);
    }
    if (spec.textScale !== undefined) {
      const r = await exec('adb', [
        '-s', spec.deviceId, 'shell', 'settings', 'put', 'system', 'font_scale', String(spec.textScale),
      ]);
      if (r.code !== 0) throw new Error(`adb font_scale failed: ${r.stderr}`);
    }
  }
}

export async function openRouteOnDevice(
  spec: ProofCellSpec,
  route: string,
  exec: CellExecFn = defaultCellExec,
): Promise<void> {
  if (spec.platformType === 'ios') {
    const r = await exec('xcrun', ['simctl', 'openurl', spec.deviceId, route]);
    if (r.code !== 0) throw new Error(`simctl openurl failed: ${r.stderr}`);
    return;
  }
  if (spec.platformType === 'android') {
    const r = await exec('adb', [
      '-s', spec.deviceId, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', route,
    ]);
    if (r.code !== 0) throw new Error(`adb am start failed: ${r.stderr}`);
  }
}

/** Network rows that count as failures for the `noFailedRequests` check. */
export function countFailedRequests(requests: NetworkRequestSnapshot[]): number {
  let failed = 0;
  for (const row of requests) {
    if (row.error || (row.statusCode !== undefined && row.statusCode >= 500)) failed++;
  }
  return failed;
}

/** Compile/diagnostic lines — deliberately stricter than `recentErrors()`; bare `Error:` banners are not failures. */
const DIAGNOSTIC = /(^|\s)(\S+\.\w+:\d+:\d+:|error\s+\w+\d+:|Failed to compile)/i;

function isDiagnostic(text: string): boolean {
  return DIAGNOSTIC.test(text);
}

export function runCellChecks(
  names: ProofCheckName[],
  evidence: {
    reachedRunning: boolean;
    logs: LogLine[];
    network: NetworkRequestSnapshot[];
    screenshotPath?: string;
    allowPatterns?: RegExp[];
  },
): Partial<Record<ProofCheckName, CheckOutcome>> {
  const out: Partial<Record<ProofCheckName, CheckOutcome>> = {};
  for (const name of names) {
    switch (name) {
      case 'running':
        out.running = evidence.reachedRunning
          ? { pass: true }
          : { pass: false, message: 'session never reached running' };
        break;
      case 'noErrors': {
        const errors = evidence.logs.filter((line) => line.error || isDiagnostic(line.text));
        const disallowed = errors.filter(
          (line) => !evidence.allowPatterns?.some((pattern) => pattern.test(line.text)),
        );
        out.noErrors = disallowed.length === 0
          ? { pass: true }
          : { pass: false, message: `${disallowed.length} error line(s)` };
        break;
      }
      case 'noFailedRequests': {
        const n = countFailedRequests(evidence.network);
        out.noFailedRequests = n === 0
          ? { pass: true }
          : { pass: false, message: `${n} failed request(s)` };
        break;
      }
      case 'screenshot':
        if (!evidence.screenshotPath) {
          out.screenshot = { pass: false, message: 'no screenshot taken' };
        } else if (!existsSync(evidence.screenshotPath)) {
          out.screenshot = { pass: false, message: 'screenshot file missing' };
        } else {
          const size = statSync(evidence.screenshotPath).size;
          out.screenshot = size >= MIN_SCREENSHOT_BYTES
            ? { pass: true }
            : { pass: false, message: `screenshot too small (${size} bytes)` };
        }
        break;
      default: {
        const _exhaustive: never = name;
        throw new Error(`unknown check: ${_exhaustive}`);
      }
    }
  }
  return out;
}

export function gitInfo(root: string): { sha?: string; dirty?: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    return { sha, dirty: status.length > 0 };
  } catch {
    return {};
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Write proof.json, per-cell evidence, network rollups, flat images/, summary.md. */
export function writeProofBundle(summary: ProofRunSummary, cellArtifacts: Map<string, {
  logs: LogLine[];
  network: NetworkRequestSnapshot[];
  screenshotSrc?: string;
}>): CellNetworkSummary[] {
  const bundlePath = summary.bundlePath;
  mkdirSync(bundlePath, { recursive: true });
  const cellsDir = join(bundlePath, 'cells');
  const imagesDir = join(bundlePath, 'images');
  mkdirSync(cellsDir, { recursive: true });
  mkdirSync(imagesDir, { recursive: true });

  const allSummaries: CellNetworkSummary[] = [];

  for (const cell of summary.cells) {
    const dir = join(cellsDir, cell.spec.id);
    mkdirSync(dir, { recursive: true });
    const artifacts = cellArtifacts.get(cell.spec.id);
    const label = formatCellLabel(cell.spec);
    if (artifacts) {
      writeFileSync(join(dir, 'logs.json'), JSON.stringify(artifacts.logs, null, 2));
      writeFileSync(join(dir, 'network.json'), JSON.stringify(artifacts.network, null, 2));
      const endpoints = summarizeNetwork(artifacts.network);
      const cellSummary: CellNetworkSummary = {
        cell: cell.spec.id,
        label,
        totalRequests: artifacts.network.filter((r) => !r.inProgress).length,
        failedRequests: countFailedRequests(artifacts.network),
        endpoints,
      };
      allSummaries.push(cellSummary);
      writeFileSync(join(dir, 'network-summary.json'), JSON.stringify(cellSummary, null, 2));
      if (artifacts.screenshotSrc && existsSync(artifacts.screenshotSrc)) {
        const shotName = `${cell.spec.id}.png`;
        copyFileSync(artifacts.screenshotSrc, join(dir, 'screenshot.png'));
        copyFileSync(artifacts.screenshotSrc, join(imagesDir, shotName));
        cell.screenshotPath = join(dir, 'screenshot.png');
      }
    }
  }

  writeFileSync(join(bundlePath, 'network-summary.json'), JSON.stringify(allSummaries, null, 2));

  writeFileSync(join(bundlePath, 'proof.json'), JSON.stringify(summary, null, 2));

  const lines: string[] = [
    `# Proof: ${summary.target}`,
    '',
    `**Result:** ${summary.passed ? 'PASSED' : 'FAILED'}`,
    `**When:** ${new Date(summary.startedAt).toISOString()}`,
    `**Duration:** ${Math.round((summary.finishedAt - summary.startedAt) / 1000)}s`,
    `**Project:** ${summary.root}`,
  ];
  if (summary.git?.sha) {
    lines.push(`**Git:** \`${summary.git.sha.slice(0, 12)}\`${summary.git.dirty ? ' (dirty)' : ''}`);
  }
  lines.push('', '## Screenshots', '');
  for (const cell of summary.cells) {
    const mark = cell.status === 'passed' ? '✓' : '✗';
    lines.push(`- ${mark} **${formatCellLabel(cell.spec)}** — \`images/${cell.spec.id}.png\``);
  }
  lines.push('', '## Network', '');
  for (const ns of allSummaries) {
    lines.push(`### ${ns.label}`, '');
    lines.push(`**${ns.totalRequests}** requests, **${ns.failedRequests}** failed`, '');
    lines.push(...networkSummaryText(ns.endpoints), '');
  }
  lines.push('## Cells', '');
  for (const cell of summary.cells) {
    const mark = cell.status === 'passed' ? '✓' : '✗';
    const failedChecks = Object.entries(cell.checks)
      .filter(([, c]) => c && !c.pass)
      .map(([name, c]) => `${name}: ${c!.message ?? 'failed'}`);
    lines.push(`- ${mark} **${formatCellLabel(cell.spec)}** — ${cell.status}${failedChecks.length ? ` — ${failedChecks.join('; ')}` : ''}`);
    if (cell.error) lines.push(`  - error: ${cell.error}`);
  }
  writeFileSync(join(bundlePath, 'summary.md'), lines.join('\n') + '\n');

  const grid = summary.cells.map((cell) => {
    const shot = join('cells', cell.spec.id, 'screenshot.png');
    const hasShot = existsSync(join(bundlePath, shot));
    const checks = Object.entries(cell.checks)
      .map(([name, c]) => `<li class="${c?.pass ? 'pass' : 'fail'}">${escapeHtml(name)}${c?.message ? `: ${escapeHtml(c.message)}` : ''}</li>`)
      .join('');
    return `<div class="cell ${cell.status}">
      <h3>${escapeHtml(cell.spec.id)}</h3>
      <p>${escapeHtml(cell.spec.deviceName)} · ${cell.status}</p>
      ${hasShot ? `<img src="${shot}" alt="${escapeHtml(cell.spec.id)}">` : '<div class="noshot">no screenshot</div>'}
      <ul>${checks}</ul>
      ${cell.error ? `<pre class="err">${escapeHtml(cell.error)}</pre>` : ''}
    </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Proof: ${escapeHtml(summary.target)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #0f1117; color: #e8eaed; }
  h1 { font-size: 1.25rem; }
  .meta { color: #9aa0a6; margin-bottom: 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .cell { background: #1a1d26; border-radius: 8px; padding: 0.75rem; border: 1px solid #2d3140; }
  .cell.passed { border-color: #34a853; }
  .cell.failed, .cell.error { border-color: #ea4335; }
  .cell img { width: 100%; border-radius: 4px; background: #000; }
  .noshot { height: 120px; display: flex; align-items: center; justify-content: center; background: #000; color: #666; border-radius: 4px; }
  .pass { color: #34a853; } .fail { color: #ea4335; }
  pre.err { font-size: 0.75rem; color: #f28b82; white-space: pre-wrap; }
</style></head><body>
<h1>Proof: ${escapeHtml(summary.target)}</h1>
<p class="meta">${summary.passed ? 'PASSED' : 'FAILED'} · ${new Date(summary.startedAt).toISOString()} · ${escapeHtml(summary.root)}</p>
<div class="grid">${grid}</div>
</body></html>`;
  writeFileSync(join(bundlePath, 'report.html'), html);
  return allSummaries;
}

/** List proof bundles newest-first. */
export function listProofs(limit = 50): ProofListEntry[] {
  const root = proofsDir();
  const entries: ProofListEntry[] = [];
  for (const name of readdirSync(root)) {
    const bundlePath = join(root, name);
    const proofFile = join(bundlePath, 'proof.json');
    if (!existsSync(proofFile)) continue;
    try {
      const summary = JSON.parse(readFileSync(proofFile, 'utf8')) as ProofRunSummary;
      entries.push({
        id: summary.id,
        target: summary.target,
        root: summary.root,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        passed: summary.passed,
        cellCount: summary.cells.length,
        bundlePath,
        zipPath: summary.zipPath,
      });
    } catch { /* skip corrupt bundles */ }
  }
  return entries.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

/** Read one proof bundle by id (directory name or prefix). */
export function getProof(id: string): ProofRunSummary | undefined {
  const root = proofsDir();
  const exact = join(root, id);
  if (existsSync(join(exact, 'proof.json'))) {
    return JSON.parse(readFileSync(join(exact, 'proof.json'), 'utf8')) as ProofRunSummary;
  }
  const matches = readdirSync(root).filter((name) => name.startsWith(id) && existsSync(join(root, name, 'proof.json')));
  if (matches.length === 1) {
    return JSON.parse(readFileSync(join(root, matches[0], 'proof.json'), 'utf8')) as ProofRunSummary;
  }
  return undefined;
}

/**
 * Everything the orchestrator needs from a live daemon — injectable for tests.
 */
export type ProofHost = {
  root: string;
  matchTarget(query: string): Target | undefined;
  matchTargetCandidates(query: string): Target[];
  listDevices(): Promise<{ connected: Device[]; bootables: Bootable[] }>;
  boot(deviceId: string): Promise<Device>;
  run(target: Target, deviceId: string): Promise<Session>;
  waitRunning(session: Session, timeoutMs: number): Promise<boolean>;
  waitStopped(session: Session, timeoutMs: number): Promise<void>;
  screenshot(session: Session, path: string): Promise<void>;
  logs(session: Session): LogLine[];
  network(session: Session): NetworkRequestSnapshot[];
  stop(session: Session): Promise<void>;
  forget(session: Session): void;
  exec?: CellExecFn;
  onProgress?: (event: ProofProgressEvent) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function cellPassed(checks: Partial<Record<ProofCheckName, CheckOutcome>>): boolean {
  return Object.values(checks).every((c) => c?.pass);
}

/** Orchestrate a full proof run across the expanded matrix. */
export async function runProof(host: ProofHost, params: ProofRunParams): Promise<ProofRunSummary> {
  const target = host.matchTarget(params.target);
  if (!target) {
    const candidates = host.matchTargetCandidates(params.target);
    if (candidates.length > 1) {
      throw new Error(
        `"${params.target}" matches ${candidates.length} targets — say which:\n` +
          candidates.map((t) => `  ${t.name}`).join('\n'),
      );
    }
    throw new Error(`no target matching "${params.target}"`);
  }

  const checks = params.checks?.length ? params.checks : DEFAULT_CHECKS;
  const settleMs = params.settleMs ?? DEFAULT_SETTLE_MS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPatterns = (params.allow ?? []).map((pattern) => new RegExp(pattern, 'i'));
  const exec = host.exec ?? defaultCellExec;

  const { connected, bootables } = await host.listDevices();
  const { cells, boots } = expandProofMatrix(params, connected, bootables);

  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const proofId = `${stamp}-${slugPart(target.name)}`;
  const bundlePath = params.out ?? join(proofsDir(), proofId);

  const emit = (event: Omit<ProofProgressEvent, 'proofId'>) => {
    host.onProgress?.({ proofId, ...event });
  };

  const booted = new Set<string>();
  for (const pick of boots) {
    if (booted.has(pick.deviceId)) continue;
    emit({ cell: '*', label: pick.deviceName, phase: 'boot', status: 'starting', message: `booting ${pick.deviceName}` });
    await host.boot(pick.deviceId);
    booted.add(pick.deviceId);
  }

  const cellResults: ProofCellResult[] = cells.map((spec) => ({
    spec, status: 'pending', checks: {},
  }));
  const artifacts = new Map<string, { logs: LogLine[]; network: NetworkRequestSnapshot[]; screenshotSrc?: string }>();
  const total = cellResults.length;
  let completed = 0;

  const runCell = async (cell: ProofCellResult): Promise<void> => {
    const { spec } = cell;
    const label = formatCellLabel(spec);
    cell.status = 'running';
    cell.startedAt = Date.now();
    emit({
      cell: spec.id, label, current: completed + 1, total, phase: 'cell', status: 'running',
    });

    let session: Session | undefined;
    let reachedRunning = false;
    let screenshotPath: string | undefined;
    const cellDir = join(bundlePath, 'cells', spec.id);
    mkdirSync(cellDir, { recursive: true });

    try {
      session = await host.run(target, spec.deviceId);
      cell.sessionId = session.id;
      reachedRunning = await host.waitRunning(session, timeoutMs);
      await applyCellSettings(spec, exec);
      if (params.route) await openRouteOnDevice(spec, params.route, exec);
      if (settleMs > 0) await sleep(settleMs);

      screenshotPath = join(cellDir, 'screenshot.png');
      if (checks.includes('screenshot') && session.capabilities.has('screenshot')) {
        try {
          await host.screenshot(session, screenshotPath);
          cell.screenshotPath = screenshotPath;
        } catch (err) {
          cell.error = (err as Error).message;
        }
      }

      const logs = host.logs(session);
      const network = host.network(session);
      artifacts.set(spec.id, { logs, network, screenshotSrc: screenshotPath });

      cell.checks = runCellChecks(checks, {
        reachedRunning,
        logs,
        network,
        screenshotPath: existsSync(screenshotPath) ? screenshotPath : undefined,
        allowPatterns,
      });
      cell.status = cellPassed(cell.checks) ? 'passed' : 'failed';
      completed++;
      emit({
        cell: spec.id, label, current: completed, total, phase: 'cell', status: cell.status,
        message: cell.status === 'failed'
          ? Object.entries(cell.checks).filter(([, c]) => !c?.pass).map(([n]) => n).join(', ')
          : undefined,
      });
    } catch (err) {
      cell.status = 'error';
      cell.error = (err as Error).message;
      completed++;
      emit({
        cell: spec.id, label, current: completed, total, phase: 'cell', status: 'error', message: cell.error,
      });
      if (session) {
        artifacts.set(spec.id, {
          logs: host.logs(session),
          network: host.network(session),
          screenshotSrc: screenshotPath,
        });
      }
    } finally {
      cell.finishedAt = Date.now();
      cell.durationMs = cell.finishedAt - (cell.startedAt ?? cell.finishedAt);
      if (session && !params.keep) {
        await host.stop(session).catch(() => {});
        await host.waitStopped(session, 60_000).catch(() => {});
        host.forget(session);
      }
    }
  };

  // One target per device at a time — appearance/scale variants on the same
  // simulator run serially; different devices still run in parallel.
  const byDevice = new Map<string, ProofCellResult[]>();
  for (const cell of cellResults) {
    const group = byDevice.get(cell.spec.deviceId) ?? [];
    group.push(cell);
    byDevice.set(cell.spec.deviceId, group);
  }

  await Promise.all(
    [...byDevice.values()].map(async (group) => {
      for (const cell of group) await runCell(cell);
    }),
  );

  const finishedAt = Date.now();
  const summary: ProofRunSummary = {
    id: proofId,
    target: target.name,
    root: host.root,
    startedAt,
    finishedAt,
    passed: cellResults.every((c) => c.status === 'passed'),
    git: gitInfo(host.root),
    cells: cellResults,
    bundlePath,
  };

  writeProofBundle(summary, artifacts);

  emit({ cell: '*', phase: 'packaging', status: 'running', message: 'packaging zip' });
  try {
    summary.zipPath = await zipProofBundle(bundlePath);
    writeFileSync(join(bundlePath, 'proof.json'), JSON.stringify(summary, null, 2));
  } catch {
    // zip is best-effort — the directory bundle is still complete
  }
  emit({ cell: '*', phase: 'done', status: summary.passed ? 'passed' : 'failed' });

  return summary;
}
