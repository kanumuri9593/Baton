#!/usr/bin/env node
import { parseWorkflow } from '../daemon/workflow.ts';
import { DaemonClient, startDaemon } from '../core/client.ts';
import { readHandshake } from '../daemon/server.ts';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { openPanel, panelSupported, hasSwift } from '../hud/panel.ts';
import { regenerationLoss } from '../config/writer.ts';
import type { RpcMethods } from '../core/api.ts';
import {
  parseAppearanceList, parseAxisList, parseTextScaleList, formatCellLabel, type ProofCheckName,
} from '../daemon/proof.ts';

const HELP = `baton — run and control dev sessions from any terminal

Usage
  baton diagnose [query] [--all] search errors (or all evidence) across sessions
  baton workflow <file.json>     launch a multi-project workflow and await readiness
  baton doctor [--json]           inspect sources, blockers and launch guidance
  baton list                     what can be run here
  baton run <target> [-d <dev>] [--branch <ref>|--checkout <path>]
                                 start a target (--force to skip pre-flight)
  baton ps                       what is running
  baton reload [target|--all]    hot reload (keeps state)
  baton restart [target|--all]   hot restart
  baton stop [target|--all]      stop
  baton forget [session|--all]   remove stopped sessions from the list
  baton checkouts                This checkout, worktrees, local and remote refs
  baton logs <target> [-n 200] [-f]   -- also works after the run has ended
  baton history [-n 20]          past runs, on disk, across daemon restarts
  baton network <session> [-n 50] [--filter re] [-f]
                                 HTTP the app made (Flutter debug sessions)
      --detail <id> [--body]     one request in full
      --clear                    forget what has been captured
  baton devices [--all]          connected devices; --all adds bootable ones
  baton boot <device>            start a simulator or emulator
  baton screenshot <session> [-o path]  capture the screen (iOS sim / Android)
  baton wait <session> [--until running|stopped|url|log:<regex>] [--timeout ms]
                                 block until a session reaches a state
  baton status <session>         cheap structured overview: status, uptime,
                                 last reload, recent errors, network counts
  baton proof <target> [--devices "iPhone SE"] [--appearance light,dark]
                                 verify across devices; outputs a zip with
                                 screenshots, network stats and logs
  baton proofs [list] [-n 20]    list past proof bundles
  baton proofs open <id>         print summary.md for one bundle
  baton projects                 projects the HUD knows about
  baton add <path>               track another project
  baton init [--force|--replace] [--claude]
                                 write a launch.json from what is detected here
                                 (--replace to overwrite one that has work in it)
  baton hud [--browser|--tab]    open the floating control panel
  baton daemon start|stop|status

Examples
  baton run "iOS Simulator (DEV / dev flavor)"
  baton run "iOS Simulator (DEV)" --branch origin/main
  baton run dev --checkout ~/wt/agent-a
  baton run dev                  # matches "npm run dev"
  baton reload --all
  baton boot "iPhone 17 Pro Max" # boot it, then run on it
  baton network mclane360 --filter 'POST|4\\d\\d'
  baton add ~/code/storefront    # watch three projects in one HUD
  baton init                     # .vscode/launch.json you can then edit anywhere
  baton wait mclane360 --until running --timeout 30000
  baton wait webapp --until log:"ready in"
`;

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => c('2', t);
const bold = (t: string) => c('1', t);
const green = (t: string) => c('32', t);
const red = (t: string) => c('31', t);
const yellow = (t: string) => c('33', t);
const blue = (t: string) => c('34', t);

const STATUS_COLOR: Record<string, (t: string) => string> = {
  running: green, starting: yellow, failed: red, stopped: dim,
};

/** "2h ago", "just now" -- coarse enough for a run list, exact timestamps are one click away. */
function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.round(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** "1.2 MB" -- binary units, one decimal past kilobytes. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (const u of units) {
    unit = u;
    if (value < 1024) break;
    value /= 1024;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** "4m 12s", "37s" -- coarse-grained, the way an uptime is usually read. */
function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** `--until running|stopped|url|log:<regex>` -- the one bit of parsing `wait` needs. */
function parseUntil(raw: string): 'running' | 'stopped' | 'url' | { log: string } {
  if (raw.startsWith('log:')) return { log: raw.slice(4) };
  if (raw === 'running' || raw === 'stopped' || raw === 'url') return raw;
  throw new Error(`--until must be running, stopped, url, or log:<regex> (got "${raw}")`);
}

function checkoutGroupHeading(group: 'this' | 'worktrees' | 'local' | 'remote'): string {
  switch (group) {
    case 'this': return 'this checkout';
    case 'worktrees': return 'worktrees';
    case 'local': return 'local';
    case 'remote': return 'remote';
    default: {
      const _exhaustive: never = group;
      return _exhaustive;
    }
  }
}

/** live / exit 0 / exit 1 / ? -- matches how `ps` shows status, at a glance. */
function runStatus(run: { live: boolean; exitCode?: number | null }): string {
  if (run.live) return 'live';
  if (run.exitCode === undefined || run.exitCode === null) return '?';
  return `exit ${run.exitCode}`;
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') flags.all = true;
    else if (arg === '-f' || arg === '--follow') flags.follow = true;
    else if (arg === '-d' || arg === '--device') flags.device = argv[++i];
    else if (arg === '--branch') flags.branch = argv[++i];
    else if (arg === '--checkout') flags.checkout = argv[++i];
    else if (arg === '-n' || arg === '--tail') flags.tail = argv[++i];
    else if (arg === '--filter') flags.filter = argv[++i];
    else if (arg === '--detail') flags.detail = argv[++i];
    else if (arg === '-o' || arg === '--out') flags.out = argv[++i];
    else if (arg === '--until') flags.until = argv[++i];
    else if (arg === '--timeout') flags.timeout = argv[++i];
    else if (arg === '--devices') flags.devices = argv[++i];
    else if (arg === '--appearance') flags.appearance = argv[++i];
    else if (arg === '--text-scale') flags['text-scale'] = argv[++i];
    else if (arg === '--locale') flags.locale = argv[++i];
    else if (arg === '--route') flags.route = argv[++i];
    else if (arg === '--checks') flags.checks = argv[++i];
    else if (arg === '--allow') flags.allow = argv[++i];
    else if (arg === '--settle') flags.settle = argv[++i];
    else if (arg === '--keep') flags.keep = true;
    else if (arg.startsWith('-')) flags[arg.replace(/^-+/, '')] = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  if (!command || command === 'help' || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  // Daemon lifecycle is handled without a client connection.
  if (command === 'daemon') {
    const action = positional[0] ?? 'status';
    if (action === 'start') {
      const handshake = await startDaemon();
      console.log(`daemon running on http://127.0.0.1:${handshake.port} (pid ${handshake.pid})`);
      return;
    }
    if (action === 'status') {
      const handshake = readHandshake();
      console.log(handshake ? `running on port ${handshake.port} (pid ${handshake.pid})` : 'not running');
      return;
    }
    if (action === 'stop') {
      const client = new DaemonClient();
      await client.connect(false).catch(() => { throw new Error('no daemon running'); });
      await client.call('shutdown');
      client.close();
      console.log('daemon stopping');
      return;
    }
    throw new Error(`unknown daemon action: ${action}`);
  }

  const client = new DaemonClient();
  await client.connect();
  const cwd = process.cwd();

  try {
    switch (command) {
      case 'diagnose': {
        console.log(JSON.stringify(await client.call('diagnose', {
          query: positional.join(' '), errorsOnly: flags.all !== true,
        }), null, 2));
        break;
      }
      case 'workflow': {
        if (!positional[0]) throw new Error('Pass a workflow JSON file.');
        const file = resolve(positional[0]);
        const plan = parseWorkflow(JSON.parse(readFileSync(file, 'utf8')), dirname(file));
        const result = await client.call('workflowRun', plan);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case 'doctor': {
        const report = await client.call('inspectProject', { cwd });
        if (rest.includes('--json')) console.log(JSON.stringify(report, null, 2));
        else {
          console.log(bold(report.root));
          console.log(`Sources: ${report.sources.join(', ') || 'none'} · revision ${report.revision}`);
          for (const issue of report.diagnostics) console.log(yellow(`${issue.file}: ${issue.message}`));
          for (const target of report.targets) {
            console.log(`  ${target.issues.length ? 'BLOCKED' : 'READY'} ${target.name} · ${target.sourceFile}`);
            for (const issue of target.issues) console.log(`    ${issue.path}: ${issue.hint}`);
            for (const warning of target.warnings) console.log(`    ${warning}`);
          }
          for (const child of report.children) console.log(`Nested project: ${child.root}`);
          if (report.guidanceFiles.length) console.log(`Project guidance: ${report.guidanceFiles.join(', ')}`);
          report.steps.forEach((step, i) => console.log(`${i + 1}. ${step}`));
        }
        break;
      }
      case 'list': {
        const { targets, root } = await client.call('targets', { cwd });
        console.log(dim(root));
        if (!targets.length) {
          console.log('no runnable targets found (no launch.json, package.json or pubspec.yaml)');
          break;
        }
        const width = Math.max(...targets.map((t: any) => t.name.length));
        for (const t of targets) {
          const blocked = t.issues?.length > 0;
          const label = blocked ? yellow(t.name.padEnd(width)) : bold(t.name.padEnd(width));
          console.log(`  ${label}  ${t.kind.padEnd(13)} ${dim(t.source)}`);
          for (const issue of t.issues ?? []) {
            console.log(`      ${yellow('!')} missing ${issue.path} ${dim('— ' + issue.hint)}`);
          }
        }
        break;
      }

      case 'ps': {
        const sessions = await client.call('sessions');
        if (!sessions.length) { console.log('nothing running'); break; }
        let stopped = 0;
        for (const s of sessions) {
          const paint = STATUS_COLOR[s.status] ?? dim;
          const extra = s.url ?? s.target ?? '';
          console.log(`  ${paint('●')} ${bold(s.id.padEnd(28))} ${paint(s.status.padEnd(9))} ${dim(extra)}`);
          if (s.progress) console.log(`    ${dim(s.progress)}`);
          if (s.status === 'stopped' || s.status === 'failed') stopped++;
        }
        if (stopped) console.log(dim(`\n  baton forget --all  clear ${stopped} stopped`));
        break;
      }

      case 'run': {
        const target = positional.join(' ');
        if (!target) throw new Error('which target? try `baton list`');
        const snapshot = await client.call('run', {
          target, cwd, deviceId: flags.device, force: flags.force === true,
          branch: typeof flags.branch === 'string' ? flags.branch : undefined,
          checkout: typeof flags.checkout === 'string' ? flags.checkout : undefined,
        });
        console.log(`${green('▸')} ${bold(snapshot.name)} ${dim('→ ' + snapshot.id)}`);
        if (snapshot.checkout?.ref) console.log(dim('  checkout ' + snapshot.checkout.ref));
        console.log(dim('  follow with: baton logs ' + snapshot.id + ' -f'));
        break;
      }

      case 'reload':
      case 'restart': {
        const params = flags.all
          ? { all: true }
          : { session: positional.join(' ') || required('which session? try `baton ps`') };
        const results = await client.call(command, params);
        if (!results.length) { console.log('nothing running'); break; }
        for (const r of results) {
          const ok = r.code === 0;
          console.log(`  ${ok ? green('✓') : red('✗')} ${r.session}${r.message ? '  ' + dim(r.message) : ''}`);
          for (const line of r.errors ?? []) console.log(`      ${red(line)}`);
        }
        if (results.some((r: any) => r.code !== 0)) process.exitCode = 1;
        break;
      }

      case 'stop': {
        const params = flags.all
          ? { all: true }
          : { session: positional.join(' ') || required('which session? try `baton ps`') };
        const stopped = await client.call('stop', params);
        for (const s of stopped) console.log(`  ${dim('■')} ${s.id}`);
        break;
      }

      case 'forget': {
        if (flags.all) {
          const { removed } = await client.call('forget', { all: true });
          if (!removed.length) { console.log('no stopped sessions'); break; }
          for (const id of removed) console.log(`  ${dim('○')} ${id}`);
          console.log(dim(`  cleared ${removed.length}`));
          break;
        }
        const session = positional.join(' ');
        if (!session) throw new Error('which session? try `baton forget --all`');
        const { removed } = await client.call('forget', { session });
        if (!removed.length) {
          throw new Error(`could not clear "${session}" — not found or still running`);
        }
        console.log(`${dim('○')} ${removed[0]}`);
        break;
      }

      case 'checkouts': {
        const listed = await client.call('checkouts', { cwd, fetch: true });
        if (!listed.length) { console.log('no checkouts'); break; }
        let group = '';
        for (const entry of listed) {
          if (entry.group !== group) {
            group = entry.group;
            console.log(dim(checkoutGroupHeading(entry.group)));
          }
          const extra = entry.cwd && entry.kind !== 'inplace' ? dim('  ' + entry.cwd) : '';
          console.log(`  ${entry.label}${extra}`);
        }
        break;
      }

      case 'logs': {
        const session = positional.join(' ');
        if (!session) throw new Error('which session? try `baton ps`');
        const lines = await client.call('logs', {
          session, tail: Number(flags.tail ?? 200), filter: flags.filter,
        });
        for (const line of lines) {
          process.stdout.write((line.error ? red(line.text) : line.text) + '\n');
        }
        if (flags.follow) {
          await new Promise<void>(() => {
            client.onEvent((msg) => {
              if (msg.event !== 'log') return;
              if (!msg.sessionId.startsWith(session) && !session.startsWith(msg.sessionId)) return;
              process.stdout.write((msg.error ? red(msg.text) : msg.text) + '\n');
            });
          });
        }
        break;
      }

      case 'history': {
        const limit = Number(flags.tail ?? 20);
        const runs = await client.call('logHistory', { limit });
        if (!runs.length) { console.log('no runs recorded yet'); break; }
        const width = Math.max(...runs.map((r: any) => r.name.length));
        for (const r of runs) {
          const paint = r.live ? green : r.exitCode ? red : dim;
          const status = runStatus(r);
          console.log(
            `  ${dim(relativeTime(r.startedAt).padEnd(9))} ` +
              `${bold(r.name.padEnd(width))}  ` +
              `${paint(status.padEnd(8))} ` +
              `${dim(humanSize(r.sizeBytes).padStart(8))}  ` +
              dim(r.runId),
          );
        }
        console.log(dim('\n  baton logs <run> to read one; works after the run has ended too'));
        break;
      }

      case 'network': {
        const session = positional.join(' ');
        if (!session) throw new Error('which session? try `baton ps`');

        if (flags.clear === true) {
          await client.call('networkClear', { session });
          console.log(dim('captured requests cleared, in the daemon and in the app'));
          break;
        }

        if (typeof flags.detail === 'string') {
          printRequestDetail(await client.call('networkDetail', { session, id: flags.detail }), flags.body === true);
          break;
        }

        const rows = await client.call('network', {
          session, tail: Number(flags.tail ?? 50), filter: flags.filter,
        });
        if (!rows.length && !flags.follow) {
          console.log('no requests captured yet');
          console.log(dim('  only dart:io HttpClient traffic is captured (package:http, dio) — not cupertino_http/cronet or websockets'));
          break;
        }
        for (const request of rows) console.log(networkRow(request));
        if (!flags.follow) {
          console.log(dim(`\n  baton network ${session} --detail <id> --body   for one request in full`));
          break;
        }
        // Live tail: the daemon pushes every request as it starts and again as
        // it finishes, so a slow call shows up immediately rather than at the end.
        const pattern = flags.filter ? new RegExp(String(flags.filter), 'i') : undefined;
        await new Promise<void>(() => {
          client.onEvent((msg) => {
            if (msg.event !== 'network') return;
            if (!msg.sessionId.startsWith(session) && !session.startsWith(msg.sessionId)) return;
            if (pattern && !pattern.test(`${msg.request.method} ${msg.request.uri}`)) return;
            console.log(networkRow(msg.request));
          });
        });
        break;
      }

      case 'devices': {
        const devices = await client.call('devices', { cwd });
        if (devices.length) {
          console.log(bold('connected'));
          for (const d of devices) {
            console.log(`  ${green('●')} ${d.name.padEnd(28)} ${dim(d.id)}  ${d.platformType}${d.emulator ? dim(' (emulator)') : ''}`);
          }
        } else {
          console.log('no devices connected');
        }
        if (!flags.all) {
          console.log(dim('\n  --all also lists simulators and emulators you can boot'));
          break;
        }
        const bootables = await client.call('bootables', { cwd });
        const startable = bootables.filter((b: any) => !b.running);
        if (!startable.length) break;
        console.log(bold('\nbootable'));
        for (const b of startable) {
          const where = b.runtime ? dim('  ' + b.runtime) : '';
          console.log(`  ${dim('○')} ${b.name.padEnd(28)} ${dim(b.id)}  ${b.platformType}${where}`);
        }
        console.log(dim('\n  baton boot "<name>"'));
        break;
      }

      case 'boot': {
        const query = positional.join(' ');
        if (!query) throw new Error('which device? try `baton devices --all`');
        const bootables = await client.call('bootables', { cwd });
        const match = pickDevice(bootables, query);
        if (!match) {
          throw new Error(
            `no bootable device matching "${query}".\n` +
              bootables.map((b: any) => '  ' + b.name).join('\n'),
          );
        }
        if (match.running) { console.log(`${green('●')} ${match.name} is already running`); break; }
        console.log(dim(`booting ${match.name}…`));
        const device = await client.call('boot', { id: match.id, cwd });
        console.log(`${green('●')} ${bold(device.name)} ${dim(device.id)}`);
        console.log(dim(`  run on it with: baton run <target> -d ${device.id}`));
        break;
      }

      case 'screenshot': {
        const session = positional.join(' ');
        if (!session) throw new Error('which session? try `baton ps`');
        const result = await client.call('screenshot', {
          session, out: typeof flags.out === 'string' ? flags.out : undefined,
        });
        console.log(`${green('✓')} ${result.path}`);
        break;
      }

      case 'wait': {
        const session = positional.join(' ');
        if (!session) throw new Error('which session? try `baton ps`');
        const until = parseUntil(typeof flags.until === 'string' ? flags.until : 'running');
        const timeoutMs = flags.timeout !== undefined ? Number(flags.timeout) : undefined;
        try {
          const result = await client.call('wait', { session, until, timeoutMs });
          const extra = result.url ? `  ${dim(result.url)}` : result.matchedLine ? `  ${dim(result.matchedLine)}` : '';
          console.log(`${green('✓')} ${result.status}${dim(` in ${result.elapsedMs}ms`)}${extra}`);
        } catch (err) {
          console.log(`${red('✗')} ${(err as Error).message}`);
          process.exitCode = 1;
        }
        break;
      }

      case 'status': {
        const session = positional.join(' ');
        if (!session) throw new Error('which session? try `baton ps`');
        const summary = await client.call('summary', { session });
        printSummary(summary);
        break;
      }

      case 'proof': {
        const target = positional.join(' ');
        if (!target) throw new Error('which target? try `baton list`');
        const checksRaw = typeof flags.checks === 'string' ? flags.checks.split(',') : undefined;
        const checks = checksRaw?.map((c) => c.trim()) as ProofCheckName[] | undefined;
        const allow = parseAxisList(typeof flags.allow === 'string' ? flags.allow : undefined);
        const devices = parseAxisList(typeof flags.devices === 'string' ? flags.devices : undefined);
        const appearance = parseAppearanceList(typeof flags.appearance === 'string' ? flags.appearance : undefined);
        const textScale = parseTextScaleList(typeof flags['text-scale'] === 'string' ? flags['text-scale'] : undefined);
        const locale = parseAxisList(typeof flags.locale === 'string' ? flags.locale : undefined);
        const settleMs = flags.settle ? Number(flags.settle) : undefined;
        const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined;

        console.log(dim(`proof: ${target}`));

        client.onEvent((msg) => {
          if (msg.event !== 'proof') return;
          if (msg.phase === 'packaging') {
            console.log(dim('  packaging…'));
            return;
          }
          if (msg.phase === 'boot') {
            console.log(dim(`  booting ${msg.label ?? msg.message ?? 'device'}…`));
            return;
          }
          if (msg.phase !== 'cell' || !msg.current || !msg.total) return;
          const mark = msg.status === 'passed' ? green('✓')
            : msg.status === 'failed' || msg.status === 'error' ? red('✗')
              : dim('…');
          const detail = msg.message ? dim(` — ${msg.message}`) : '';
          console.log(`  [${msg.current}/${msg.total}] ${msg.label ?? msg.cell} ${mark}${detail}`);
        });

        const result = await client.call('proofRun', {
          target,
          branch: typeof flags.branch === 'string' ? flags.branch : undefined,
          checkout: typeof flags.checkout === 'string' ? flags.checkout : undefined,
          cwd,
          devices,
          appearance,
          textScale,
          locale,
          route: typeof flags.route === 'string' ? flags.route : undefined,
          checks,
          allow,
          keep: flags.keep === true,
          out: typeof flags.out === 'string' ? flags.out : undefined,
          settleMs: Number.isFinite(settleMs) ? settleMs : undefined,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
        });

        console.log('');
        if (result.passed) {
          console.log(`${green('✓')} passed — ${result.cells.length} cell(s), ${Math.round((result.finishedAt - result.startedAt) / 1000)}s`);
        } else {
          const failed = result.cells.filter((c) => c.status !== 'passed');
          console.log(`${red('✗')} failed — ${failed.length}/${result.cells.length} cell(s)`);
          for (const cell of failed) {
            const bad = Object.entries(cell.checks).filter(([, v]) => v && !v.pass).map(([k]) => k);
            console.log(`    ${red('✗')} ${formatCellLabel(cell.spec)}${bad.length ? ` (${bad.join(', ')})` : ''}`);
            if (cell.error) console.log(dim(`      ${cell.error}`));
          }
        }
        if (result.zipPath) {
          console.log(`  ${bold(result.zipPath)}`);
        } else {
          console.log(dim(`  bundle: ${result.bundlePath}`));
        }
        if (!result.passed) process.exitCode = 1;
        break;
      }

      case 'proofs': {
        const sub = positional[0] ?? 'list';
        if (sub === 'open') {
          const id = positional.slice(1).join(' ');
          if (!id) throw new Error('which proof? try `baton proofs`');
          const proof = await client.call('proofGet', { id });
          const summaryPath = `${proof.bundlePath}/summary.md`;
          if (existsSync(summaryPath)) {
            process.stdout.write(readFileSync(summaryPath, 'utf8'));
          } else {
            printProofSummary(proof);
          }
          break;
        }
        const limit = flags.tail ? Number(flags.tail) : 20;
        const proofs = await client.call('proofList', { limit });
        if (!proofs.length) {
          console.log('no proofs yet — run `baton proof <target>`');
          break;
        }
        for (const p of proofs) {
          const mark = p.passed ? green('✓') : red('✗');
          const zip = p.zipPath ? dim(`  ${p.zipPath}`) : '';
          console.log(`${mark} ${p.id}  ${p.target}  ${p.cellCount} cell(s)  ${relativeTime(p.startedAt)}`);
          if (zip) console.log(zip);
          else console.log(dim(`    ${p.bundlePath}`));
        }
        break;
      }

      case 'projects': {
        const { projects, active } = await client.call('projects', { cwd });
        for (const project of projects) {
          const mark = project.root === active ? green('●') : dim('○');
          const detail = project.error
            ? red(project.error)
            : dim(project.targets.length + ' targets');
          console.log(`  ${mark} ${bold(project.name.padEnd(22))} ${detail}  ${dim(project.root)}`);
        }
        console.log(dim('\n  baton add <path> to track another'));
        break;
      }

      case 'add': {
        const path = positional.join(' ') || cwd;
        const project = await client.call('addProject', { path });
        console.log(`${green('+')} ${bold(project.name)} ${dim(project.root)}`);
        for (const t of project.targets) console.log(`    ${t.name}  ${dim(t.kind)}`);
        // Not tracked yet, on purpose -- say what would make it stick, rather
        // than leaving the next `baton projects` looking like the add failed.
        if (project.needsConfig) {
          console.log(yellow('    nothing runnable found here yet'));
          console.log(dim('    baton init  writes a launch.json from what is detected'));
        }
        break;
      }

      case 'init': {
        // The point of the whole command: get a first launch.json without
        // anyone having to learn the schema or open an IDE to write it.
        const current = await client.call('readLaunchConfig', { root: cwd });
        const replace = flags.replace === true;

        // A .claude file written while .vscode/launch.json exists is dead on
        // arrival: detection reads .vscode first, so the new file would be
        // reported as created and then never used again.
        if (flags.claude === true && current.file && basename(dirname(current.file)) === '.vscode') {
          throw new Error(
            `${current.file} already exists, and is read before .claude/launch.json.\n` +
              '  A .claude file written now would never be used. Edit the .vscode one instead,\n' +
              '  or delete it first if .claude is where this project should keep its config.',
          );
        }

        if (current.file && !replace && flags.force !== true) {
          throw new Error(`${current.file} already exists — pass --force to replace it`);
        }
        // --force is not enough to destroy work. Regeneration writes only what
        // detection can see, which is a fraction of what a launch.json can say,
        // so an existing file with anything in it has to be named before it can
        // be thrown away -- and even then it is copied aside first.
        if (current.file && !replace) refuseToRegenerate(current);

        const { text, targets } = await client.call('generateLaunchConfig', { root: cwd });
        if (!targets.length) {
          console.log(yellow('nothing detected here — writing an empty launch.json to fill in'));
        }
        if (current.file && replace) {
          const backup = backUp(current.file);
          console.log(`${dim('saved the previous file as')} ${backup}`);
        }
        const written = await client.call('writeLaunchConfig', {
          root: cwd,
          text,
          // Only forced when asked: otherwise the daemon writes back to whichever
          // file this project already uses, instead of shadowing it with a new one.
          file: flags.claude === true ? 'claude' : undefined,
        });

        console.log(`${green('+')} ${bold(written.file)}`);
        for (const config of written.configs) {
          const issues = written.issues[config.name] ?? [];
          console.log(`    ${issues.length ? yellow(config.name) : config.name}  ${dim(config.kind)}`);
          for (const issue of issues) {
            console.log(`      ${yellow('!')} missing ${issue.path} ${dim('— ' + issue.hint)}`);
          }
        }
        console.log(dim('\n  VS Code and Cursor read the same file; edit it there, or with ⚙ in the HUD'));
        break;
      }

      case 'hud': {
        // Register the terminal's project first, so a window with no cwd of its
        // own still opens on the project you are standing in.
        await client.call('useProject', { root: cwd }).catch(() => {});
        const handshake = readHandshake()!;
        const url = `http://127.0.0.1:${handshake.port}/`;

        // On macOS the native panel is the real thing: menu-bar item, always on
        // top, draggable, and it never steals focus. Only fall back to a browser
        // window when that is impossible or explicitly asked for.
        const wantsBrowser = flags.browser === true || flags.tab === true;
        if (!wantsBrowser && panelSupported() && hasSwift()) {
          try {
            openPanel(() => console.log(dim('  compiling the panel (first run only)…')));
            console.log(`${green('●')} HUD in the menu bar  ${dim(url)}`);
            console.log(dim('  click the ● to show or hide it; right-click for reload/restart/stop'));
            break;
          } catch (err) {
            console.log(yellow('  ' + (err as Error).message));
          }
        }
        console.log(`HUD → ${url}`);
        openHud(url, flags.tab === true);
        break;
      }

      default:
        throw new Error(`unknown command: ${command}\n\n${HELP}`);
    }
  } finally {
    if (!flags.follow) client.close();
  }
}

// --- network inspector ------------------------------------------------------

/** "87ms" up to a second, "1.2s" beyond it -- the scale you care about changes there. */
function duration(ms?: number): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Path and query only: the host is the same for every row of a given app. */
function shortUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    return parsed.pathname + parsed.search;
  } catch {
    return uri;
  }
}

const STATUS_PAINT = (code: number) =>
  code < 300 ? green : code < 400 ? blue : red;

/**
 * One request as a table row: `GET  200  87ms   1.2 KB  /v2/orders?page=2`.
 *
 * Padding is applied before colour, because escape codes count towards a
 * string's length and would knock every column out of line.
 */
function networkRow(r: {
  id: string; method: string; uri: string; statusCode?: number; durationMs?: number;
  responseContentLength?: number; error?: string; inProgress: boolean;
}): string {
  const status = r.error
    ? red('err'.padEnd(5))
    : r.inProgress
      ? yellow('…'.padEnd(5))
      : r.statusCode === undefined
        ? dim('?'.padEnd(5))
        : STATUS_PAINT(r.statusCode)(String(r.statusCode).padEnd(5));

  const size = r.responseContentLength === undefined ? '' : humanSize(r.responseContentLength);
  const prefix = `  ${bold(r.method.padEnd(6))} ${status} ${dim(duration(r.durationMs).padStart(6))} ${dim(size.padStart(9))}  `;

  // The isolate half of the id is noise to a reader -- `--detail` takes the short
  // form and resolves it, so that is what the table shows.
  const id = ' #' + r.id.slice(r.id.lastIndexOf('#') + 1);
  // The prefix above is exactly 33 columns wide (2 + 6 + 1 + 5 + 1 + 6 + 1 + 9 + 2).
  // Truncate rather than let a long URI wrap: a wrapped row is much harder to
  // scan than a shortened one.
  const room = Math.max(20, (process.stdout.columns || 100) - 33 - id.length);
  const uri = shortUri(r.uri);
  return prefix + (uri.length > room ? uri.slice(0, room - 1) + '…' : uri) +
    dim(id) + (r.error ? '  ' + red(r.error) : '');
}

/**
 * First value of a header, matched case-insensitively.
 *
 * Header names come back exactly as the app set them -- `Content-Type` from one
 * client, `content-type` from another -- so a lookup that assumes either case
 * silently finds nothing and the body prints unformatted. Mirrors
 * `headerValue` in vm/network-monitor.ts.
 */
function headerValue(headers: Record<string, string[]> | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return values[0];
  }
  return undefined;
}

/** Headers as `name: value`, one line per value -- a repeated header is not a list to squint at. */
function printHeaders(label: string, headers?: Record<string, string[]>): void {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return;
  console.log(bold(`\n${label}`));
  for (const [name, values] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    for (const value of values) console.log(`  ${dim(name + ':')} ${value}`);
  }
}

/** Pretty-print a body when it is JSON and we are sure it is text. */
function printBody(label: string, body: { text?: string; size: number; truncated: boolean } | undefined, contentType = ''): void {
  if (!body) return;
  console.log(bold(`\n${label}`) + dim(`  ${humanSize(body.size)}${body.truncated ? ', truncated' : ''}`));
  if (body.text === undefined) {
    console.log(dim(`  <binary, ${body.size} bytes>`));
    return;
  }
  let text = body.text;
  if (/json/i.test(contentType)) {
    try {
      text = JSON.stringify(JSON.parse(body.text), null, 2);
    } catch { /* a truncated or non-conforming body prints as it arrived */ }
  }
  for (const line of text.split('\n')) console.log('  ' + line);
}

/** `baton status <session>`: status, uptime, device/url, last reload, errors, network. */
function printSummary(summary: RpcMethods['summary']['result']): void {
  const s = summary.session;
  const paint = STATUS_COLOR[s.status] ?? dim;
  console.log(`${paint('●')} ${bold(s.id)}  ${paint(s.status)}  ${dim('up ' + humanDuration(summary.uptimeMs))}`);

  const where = s.url ?? s.target;
  if (where) console.log(dim(`  ${where}`));

  if (summary.lastOperation) {
    const op = summary.lastOperation;
    const mark = op.ok ? green('✓') : red('✗');
    console.log(`  last ${op.kind}: ${mark} ${dim(relativeTime(op.at))}${op.message ? '  ' + dim(op.message) : ''}`);
  }

  if (summary.recentErrors.length) {
    console.log(`  ${red(`${summary.recentErrors.length} error(s)`)} ${dim(`(of ${summary.logLines} log lines)`)}`);
    for (const line of summary.recentErrors.slice(-3)) console.log(`    ${red(line)}`);
  } else {
    console.log(dim(`  no recent errors (${summary.logLines} log lines)`));
  }

  if (summary.network) {
    const n = summary.network;
    console.log(dim(`  network: ${n.total} total, ${n.failed} failed, ${n.inFlight} in flight`));
  }
}

function printProofSummary(proof: RpcMethods['proofGet']['result']): void {
  console.log(`# Proof: ${proof.target}`);
  console.log(`Result: ${proof.passed ? 'PASSED' : 'FAILED'}`);
  console.log(`Bundle: ${proof.bundlePath}`);
  for (const cell of proof.cells) {
    const mark = cell.status === 'passed' ? green('✓') : red('✗');
    console.log(`${mark} ${cell.spec.id} — ${cell.status}`);
  }
}

function printRequestDetail(
  detail: {
    method: string; uri: string; statusCode?: number; reasonPhrase?: string; durationMs?: number;
    error?: string; inProgress: boolean; contentType?: string;
    requestHeaders: Record<string, string[]>; responseHeaders?: Record<string, string[]>;
    requestBody?: { text?: string; size: number; truncated: boolean };
    responseBody?: { text?: string; size: number; truncated: boolean };
  },
  withBodies: boolean,
): void {
  const outcome = detail.error
    ? red(detail.error)
    : detail.inProgress
      ? yellow('in flight')
      : detail.statusCode === undefined
        ? dim('no response')
        : STATUS_PAINT(detail.statusCode)(`${detail.statusCode} ${detail.reasonPhrase ?? ''}`.trim());

  const timing = duration(detail.durationMs);
  console.log(`${bold(detail.method)} ${detail.uri}`);
  console.log(outcome + (timing ? '  ' + dim(timing) : ''));

  printHeaders('request headers', detail.requestHeaders);
  printHeaders('response headers', detail.responseHeaders);
  if (!withBodies) {
    console.log(dim('\n  --body to print the request and response bodies'));
    return;
  }
  printBody('request body', detail.requestBody, headerValue(detail.requestHeaders, 'content-type'));
  printBody('response body', detail.responseBody, detail.contentType);
}

// --- `baton init` guard rails -----------------------------------------------

/**
 * Refuse to regenerate over a launch.json that has something in it.
 *
 * `generateLaunchJson` writes only what `detectTargets` can see. A hand-tuned
 * file carries far more -- the flavour, the device, the dart-define files, the
 * env -- and none of it survives a regeneration, comments included. The old
 * `--force` did exactly that, printed the same configuration names afterwards,
 * and left no backup: the loss was invisible from the output.
 *
 * So the file is read first and everything at risk is named, item by item,
 * before anything is written. `--replace` is the way through, and it takes a
 * copy on the way past.
 */
function refuseToRegenerate(current: RpcMethods['readLaunchConfig']['result']): void {
  const ways =
    `\n\n  Edit it instead:     baton hud   ${dim('(⚙ on the project tab)')}, or open it in any editor` +
    `\n  Replace it anyway:   baton init --replace   ${dim('(copies the current file aside first)')}`;

  // A file that does not parse cannot be assessed at all, which is the strongest
  // possible reason not to overwrite it: there is no telling what is in there.
  if (current.parseErrors.length > 0) {
    throw new Error(
      `${current.file} does not parse, so there is no telling what regenerating would throw away:\n` +
        current.parseErrors.slice(0, 5)
          .map((e) => `    ${e.line}:${e.col}  ${e.message}`).join('\n') +
        ways,
    );
  }

  const loss = regenerationLoss(current.configs, current.text);
  if (!loss.any) return; // nothing in it worth keeping; --force is enough

  const width = Math.max(...loss.configs.map((c) => c.name.length));
  const lines = loss.configs.map((c) =>
    `    ${yellow(c.name.padEnd(width))}  ` +
    (c.dropped
      ? red('would disappear entirely') + dim(' — nothing detectable to run')
      : c.keys.join(', ')));

  throw new Error(
    `${current.file} holds ${loss.configs.length} configuration` +
      `${loss.configs.length === 1 ? '' : 's'} that regenerating cannot write back:\n` +
      lines.join('\n') +
      (loss.commentLines ? `\n  ${dim(`and ${loss.commentLines} comment line${loss.commentLines === 1 ? '' : 's'}`)}` : '') +
      `\n\n  ${dim('init writes only what Baton can detect — a name, a program or a command. Everything above would be lost.')}` +
      ways,
  );
}

/** Copy a file aside before it is replaced, without ever overwriting an older copy. */
function backUp(file: string): string {
  let backup = `${file}.bak`;
  if (existsSync(backup)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.${stamp}.bak`;
  }
  copyFileSync(file, backup);
  return backup;
}

/** Exact name, then case-insensitive substring -- the same rule as targets. */
function pickDevice(devices: any[], query: string): any {
  const exact = devices.find((d) => d.name === query || d.id === query);
  if (exact) return exact;
  const lower = query.toLowerCase();
  return devices.find((d) => d.name.toLowerCase().includes(lower));
}

function required(message: string): never {
  throw new Error(message);
}

/** Chromium builds that support `--app=`, in the order we prefer them. */
const APP_MODE_BROWSERS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

/**
 * Open the HUD as a small chromeless window when a Chromium build is available.
 *
 * `--app=` gives a window with no tabs, address bar or bookmarks -- close to a
 * real floating panel, and identical on all three platforms. Falls back to an
 * ordinary browser tab when no such browser is installed.
 */
function openHud(url: string, forceTab: boolean): void {
  if (!forceTab) {
    for (const path of APP_MODE_BROWSERS[process.platform] ?? []) {
      if (!existsSync(path)) continue;
      spawn(path, [`--app=${url}`, '--window-size=420,560', '--window-position=60,80'], {
        stdio: 'ignore', detached: true,
      }).unref();
      console.log(dim('  opened as a panel window; use --tab for an ordinary browser tab'));
      return;
    }
  }
  openBrowser(url);
}

/** Open a URL in the platform's default browser. */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

main().catch((err) => {
  process.stderr.write(red('✗ ') + (err as Error).message + '\n');
  process.exit(1);
});
