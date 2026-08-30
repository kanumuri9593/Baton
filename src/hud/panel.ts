import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stateDir } from '../core/paths.ts';

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
  <key>CFBundleName</key><string>Baton HUD</string>
  <key>CFBundleDisplayName</key><string>Baton HUD</string>
  <key>CFBundleIdentifier</key><string>dev.baton.hud</string>
  <key>CFBundleExecutable</key><string>BatonHUD</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- Menu-bar only: no Dock icon, and it never activates over your terminal. -->
  <key>LSUIElement</key><true/>
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
 * Keyed on a hash of the Swift source, so editing the source rebuilds and
 * nothing else does -- compiling takes a few seconds and should not happen on
 * every `baton hud`.
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
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');

  const current = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
  if (existsSync(binary) && current === hash) return app;

  onBuild?.();
  mkdirSync(dirname(binary), { recursive: true });
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), INFO_PLIST);

  // The icon is generated from assets/baton.svg by `npm run icons`, so it is
  // often absent. The panel lives in the menu bar and has no Dock tile, so a
  // missing icon costs nothing but a generic look in Finder.
  const icns = join(dirname(import.meta.dirname), '..', 'assets', 'baton.icns');
  if (existsSync(icns)) copyFileSync(icns, join(dirname(stamp), 'baton.icns'));
  execFileSync('xcrun', ['swiftc', '-O', '-o', binary, source], { stdio: 'inherit' });
  writeFileSync(stamp, hash);
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
