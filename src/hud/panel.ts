import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { logDir, stateDir } from '../core/paths.ts';

/**
 * The native macOS shell around the HUD.
 *
 * A browser window cannot be told to float above a full-screen terminal or to
 * live in the menu bar -- those are window-server privileges. So the panel is a
 * ~250-line AppKit app that hosts the very same page the daemon already serves.
 * It is compiled on first use rather than shipped as a binary: no code signing,
 * no notarisation, nothing to trust beyond the source in this repository.
 */
export function panelSupported(): boolean {
  return process.platform === 'darwin';
}

function sourcePath(): string {
  // src/hud/panel.ts -> <package>/hud/mac/main.swift
  return join(dirname(import.meta.dirname), '..', 'hud', 'mac', 'main.swift');
}

function appPath(): string {
  return join(stateDir(), 'BatonHUD.app');
}

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Baton</string>
  <key>CFBundleDisplayName</key><string>Baton</string>
  <key>CFBundleIdentifier</key><string>dev.baton.hud</string>
  <key>CFBundleExecutable</key><string>BatonHUD</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.1</string>
  <key>CFBundleVersion</key><string>4</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>CFBundleIconFile</key><string>baton</string>
  <!-- The daemon is plain HTTP on loopback; ATS blocks that without this. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;

/** Whether a Swift toolchain is present, without throwing if it is not. */
export function hasSwift(): boolean {
  try {
    execFileSync('xcrun', ['-f', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile the panel app if it is missing or out of date, and return its path.
 *
 * Keyed on a hash of the Swift source, Info.plist, and the generated icns, so
 * editing any of them rebuilds and nothing else does -- compiling takes a few
 * seconds and should not happen on every `baton hud`.
 */
export function buildPanelApp(onBuild?: () => void): string {
  const source = sourcePath();
  if (!existsSync(source)) throw new Error(`panel source is missing: ${source}`);
  if (!hasSwift()) {
    throw new Error(
      'the floating panel needs a Swift toolchain (Xcode or the Command Line Tools).\n' +
        'Install it with `xcode-select --install`, or use `baton hud` for the browser HUD.',
    );
  }

  const app = appPath();
  const binary = join(app, 'Contents', 'MacOS', 'BatonHUD');
  const stamp = join(app, 'Contents', 'Resources', 'source.sha');
  const icns = join(dirname(import.meta.dirname), '..', 'assets', 'baton.icns');
  // A GUI app does not inherit the terminal's npm PATH reliably. Bundle the
  // exact Node + daemon entry paths that built it so reopening from the Dock can
  // bring Baton back after an intentional Quit shut the daemon down.
  const entry = join(dirname(import.meta.dirname), 'cli', 'index.ts');
  const daemonLog = join(logDir(), 'daemon.log');
  // Use the CLI's locked startup path here as well. Launching daemon/main.ts
  // directly let a transient handshake miss create an independent runner.
  const launcher = JSON.stringify({
    node: process.execPath,
    entry,
    arguments: ['daemon', 'start'],
    log: daemonLog,
  }, null, 2);
  const hash = createHash('sha256').update(readFileSync(source)).update(INFO_PLIST).update(launcher);
  if (existsSync(icns)) hash.update(readFileSync(icns));
  const digest = hash.digest('hex');

  const current = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
  if (existsSync(binary) && current === digest) return app;

  onBuild?.();
  mkdirSync(dirname(binary), { recursive: true });
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), INFO_PLIST);
  writeFileSync(join(dirname(stamp), 'launcher.json'), launcher);
  // Swift opens this for append. Ensure a first-ever launch has a file to open.
  closeSync(openSync(daemonLog, 'a'));

  // The icon is generated from assets/baton.svg by `npm run icons`. A missing
  // icns still gets a drawn Dock tile from the Swift host.
  if (existsSync(icns)) copyFileSync(icns, join(dirname(stamp), 'baton.icns'));
  execFileSync('xcrun', ['swiftc', '-O', '-o', binary, source], { stdio: 'inherit' });
  writeFileSync(stamp, digest);
  return app;
}

/**
 * Bring the panel up.
 *
 * LaunchServices reuses a running instance, so calling this twice does not
 * leave two icons in the menu bar.
 */
export function openPanel(onBuild?: () => void): string {
  const app = buildPanelApp(onBuild);
  spawn('open', ['-a', app], { stdio: 'ignore', detached: true }).unref();
  return app;
}
