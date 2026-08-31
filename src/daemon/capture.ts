import { execFile, type ExecFileException } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safe } from '../core/log-store.ts';
import { stateDir } from '../core/paths.ts';
import type { SessionSnapshot } from '../core/types.ts';

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

const UNSUPPORTED = 'screenshots need an iOS simulator or Android device session';

/** iOS simulator UDIDs: `48F0A0D1-0CEC-4781-B73B-BE0F494DD23D`. */
const IOS_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
): Promise<{ path: string }> {
  const target = snapshot.target;
  if (!target) throw new Error(UNSUPPORTED);

  const platform = resolvePlatform(target, platformHint);
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
