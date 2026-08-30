#!/usr/bin/env node
import { DaemonClient, startDaemon } from '../core/client.ts';
import { readHandshake } from '../daemon/server.ts';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { openPanel, panelSupported, hasSwift } from '../hud/panel.ts';

const HELP = `baton — run and control dev sessions from any terminal

Usage
  baton list                     what can be run here
  baton run <target> [-d <dev>]  start a target (--force to skip pre-flight)
  baton ps                       what is running
  baton reload [target|--all]    hot reload (keeps state)
  baton restart [target|--all]   hot restart
  baton stop [target|--all]      stop
  baton logs <target> [-n 200] [-f]
  baton devices [--all]          connected devices; --all adds bootable ones
  baton boot <device>            start a simulator or emulator
  baton projects                 projects the HUD knows about
  baton add <path>               track another project
  baton hud [--browser|--tab]    open the floating control panel
  baton daemon start|stop|status

Examples
  baton run "iOS Simulator (DEV / dev flavor)"
  baton run dev                  # matches "npm run dev"
  baton reload --all
  baton boot "iPhone 17 Pro Max" # boot it, then run on it
  baton add ~/code/storefront    # watch three projects in one HUD
`;

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => c('2', t);
const bold = (t: string) => c('1', t);
const green = (t: string) => c('32', t);
const red = (t: string) => c('31', t);
const yellow = (t: string) => c('33', t);

const STATUS_COLOR: Record<string, (t: string) => string> = {
  running: green, starting: yellow, failed: red, stopped: dim,
};

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') flags.all = true;
    else if (arg === '-f' || arg === '--follow') flags.follow = true;
    else if (arg === '-d' || arg === '--device') flags.device = argv[++i];
    else if (arg === '-n' || arg === '--tail') flags.tail = argv[++i];
    else if (arg === '--filter') flags.filter = argv[++i];
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
        for (const s of sessions) {
          const paint = STATUS_COLOR[s.status] ?? dim;
          const extra = s.url ?? s.target ?? '';
          console.log(`  ${paint('●')} ${bold(s.id.padEnd(28))} ${paint(s.status.padEnd(9))} ${dim(extra)}`);
          if (s.progress) console.log(`    ${dim(s.progress)}`);
        }
        break;
      }

      case 'run': {
        const target = positional.join(' ');
        if (!target) throw new Error('which target? try `baton list`');
        const snapshot = await client.call('run', {
          target, cwd, deviceId: flags.device, force: flags.force === true,
        });
        console.log(`${green('▸')} ${bold(snapshot.name)} ${dim('→ ' + snapshot.id)}`);
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
