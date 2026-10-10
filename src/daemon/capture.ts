import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { safe } from '../core/log-store.ts';
import { stateDir } from '../core/paths.ts';
import type { SessionSnapshot } from '../core/types.ts';
import { captureWithDevTools, type WebCaptureFn, type WebEvidence, type WebViewport } from './web-capture.ts';

/** What one shell-out returns -- `stdout` is a Buffer only when binary output was asked for. */
export type ExecResult = { code: number; stdout: string | Buffer; stderr: string };

/**
 * How `screenshotSession` runs external tools. Injectable so tests never shell
 * out to a real `xcrun` or `adb`.
 *
 * `opts.encoding` picks the shape of `stdout`: 'utf8' (the default) for tools
 * whose result is a path or a message, 'buffer' for `adb exec-out`, which writes
 * raw PNG bytes to its own stdout.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { encoding?: 'utf8' | 'buffer' },
) => Promise<ExecResult>;

function errorCode(err: ExecFileException): number {
  return typeof err.code === 'number' ? err.code : 1;
}

/** Default `ExecFn`: `child_process.execFile`, promisified by hand so binary stdout survives. */
export const defaultExec: ExecFn = (cmd, args, opts) => {
  const maxBuffer = 64 * 1024 * 1024;
  if (opts?.encoding === 'buffer') {
    return new Promise((resolve) => {
      execFile(cmd, args, { encoding: 'buffer', maxBuffer }, (err, stdout, stderr) => {
        const stderrText = stderr ? stderr.toString('utf8') : '';
        resolve({
          code: err ? errorCode(err) : 0,
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderrText || (err ? err.message : ''),
        });
      });
    });
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer }, (err, stdout, stderr) => {
      resolve({
        code: err ? errorCode(err) : 0,
        stdout: stdout ?? '',
        stderr: stderr || (err ? err.message : ''),
      });
    });
  });
};

const UNSUPPORTED = 'screenshots need an iOS simulator, an Android device, or a session with a URL';

/** Named viewports, so an agent can say "phone" instead of remembering pixel sizes. */
export const VIEWPORTS: Record<string, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
};

/** `phone` / `tablet` / `desktop`, or `<width>x<height>`. Undefined means desktop. */
export function parseViewport(viewport?: string): { width: number; height: number } {
  if (!viewport) return VIEWPORTS.desktop;
  const named = VIEWPORTS[viewport.toLowerCase()];
  if (named) return named;
  const match = /^(\d{2,5})\s*x\s*(\d{2,5})$/i.exec(viewport.trim());
  if (!match) {
    throw new Error(`viewport must be phone, tablet, desktop or WIDTHxHEIGHT (got "${viewport}")`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Where a Chromium-family browser lives on this machine, if anywhere.
 *
 * `BATON_CHROME` wins, so a machine with an unusual install can point at it.
 * After that: the usual app bundles on macOS, Program Files on Windows, and
 * the usual names on PATH everywhere else.
 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | undefined {
  if (env.BATON_CHROME) return env.BATON_CHROME;
  const candidates: string[] = [];
  if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser', 'Google Chrome Canary']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
    }
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  }
  const names = platform === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) candidates.push(join(dir, name));
  }
  return candidates.find((c) => {
    try { return statSync(c).isFile(); } catch { return false; }
  });
}

/** Where the PNG went, plus (web only) what the page reported while it loaded. */
export type ScreenshotResult = { path: string } & Partial<WebEvidence>;

/** What `screenshotSession` may be told beyond the session itself. */
export type ScreenshotOptions = {
  /** Web captures only: `phone`, `tablet`, `desktop` or `WIDTHxHEIGHT`. */
  viewport?: string;
  /** Browser binary for web captures. Defaults to `findBrowser()`. */
  browser?: string;
  /** How a web capture is taken. Defaults to the DevTools protocol; tests swap it. */
  capture?: WebCaptureFn;
};

/** iOS simulator UDIDs: `48F0A0D1-0CEC-4781-B73B-BE0F494DD23D`. */
const IOS_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Flutter's web device ids, which would otherwise look like an Android serial. */
const WEB_DEVICES = new Set(['chrome', 'edge', 'web-server']);
/** Android serials: `emulator-5554`, or a physical device's alphanumeric serial. */
const ANDROID_SERIAL = /^(emulator-\d+|[0-9a-z]{6,})$/i;

/**
 * Which capture path a device target needs.
 *
 * `platformHint` -- the device registry's own `platformType`, when the caller
 * has it -- is authoritative and always wins. Guessing from the id's shape is
 * only a fallback for targets the registry does not (yet) know about.
 */
function resolvePlatform(target: string, platformHint?: string): 'ios' | 'android' | undefined {
  if (platformHint !== undefined) {
    const p = platformHint.toLowerCase();
    if (p === 'ios') return 'ios';
    if (p === 'android') return 'android';
    return undefined; // a real, known platform that is neither -- e.g. macos, web
  }
  if (WEB_DEVICES.has(target.toLowerCase())) return undefined;
  if (IOS_UDID.test(target)) return 'ios';
  if (ANDROID_SERIAL.test(target)) return 'android';
  return undefined;
}

/** `<stateDir()>/screenshots/<session-id>-<timestamp>.png`, directory created. */
function defaultOutPath(sessionId: string): string {
  const dir = join(stateDir(), 'screenshots');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dir, `${safe(sessionId)}-${stamp}.png`);
}

/**
 * Capture the screen of a running session, in the daemon rather than a client.
 *
 * This is what lets the CLI, the HUD and MCP all take a screenshot the same
 * way, and what makes Android possible at all: the old MCP-only implementation
 * only ever ran `xcrun simctl`.
 */
export async function screenshotSession(
  snapshot: SessionSnapshot,
  outPath?: string,
  exec: ExecFn = defaultExec,
  platformHint?: string,
  options: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const target = snapshot.target;
  const platform = target ? resolvePlatform(target, platformHint) : undefined;
  // A React Native URL is the Metro bundler, not the app, so it is no use to capture.
  if (!platform && snapshot.url && snapshot.kind !== 'react-native') {
    return screenshotUrl(snapshot, outPath, options);
  }
  if (!target) throw new Error(UNSUPPORTED);

  const path = outPath ?? defaultOutPath(snapshot.id);
  mkdirSync(dirname(path), { recursive: true });

  if (platform === 'ios') {
    const result = await exec('xcrun', ['simctl', 'io', target, 'screenshot', path]);
    if (result.code !== 0) {
      throw new Error(`xcrun simctl screenshot failed: ${result.stderr || `exit ${result.code}`}`);
    }
    return { path };
  }

  if (platform === 'android') {
    const result = await exec('adb', ['-s', target, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' });
    if (result.code !== 0) {
      throw new Error(`adb screencap failed: ${result.stderr || `exit ${result.code}`}`);
    }
    const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
    if (bytes.length === 0) throw new Error('adb screencap produced no data');
    writeFileSync(path, bytes);
    return { path };
  }

  throw new Error(UNSUPPORTED);
}

/**
 * Capture a web session by loading its URL in a throwaway headless browser,
 * sized and behaving like the viewport asked for.
 */
async function screenshotUrl(
  snapshot: SessionSnapshot,
  outPath: string | undefined,
  options: ScreenshotOptions,
): Promise<ScreenshotResult> {
  const url = snapshot.url!;
  const viewport = webViewport(options.viewport);
  const browser = options.browser ?? findBrowser();
  if (!browser) {
    throw new Error(
      'web screenshots need Chrome, Chromium, Edge or Brave installed (or BATON_CHROME set to a browser binary)',
    );
  }
  const path = outPath ?? defaultOutPath(snapshot.id);
  mkdirSync(dirname(path), { recursive: true });
  let evidence: WebEvidence | void;
  try {
    evidence = await (options.capture ?? captureWithDevTools)(browser, url, viewport, path);
  } catch (err) {
    throw new Error(`headless browser screenshot of ${url} failed: ${(err as Error).message}`);
  }
  if (!existsSync(path)) throw new Error(`headless browser screenshot of ${url} failed: no image was written`);
  return { path, ...(evidence ?? {}) };
}

/** Anything narrower than 1024px (phone, tablet) is a mobile viewport at 2x; desktop is 1x. */
export function webViewport(viewport?: string): WebViewport {
  const { width, height } = parseViewport(viewport);
  const mobile = width < 1024 && (viewport ?? '').toLowerCase() !== 'desktop';
  return { width, height, mobile, scale: mobile ? 2 : 1 };
}
