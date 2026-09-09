import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectTargets, findProjectRoot, isNativeProjectSelection, isProjectRoot,
} from '../src/config/detect.ts';
import { inspectProject } from '../src/config/guide.ts';
import { generateLaunchJson } from '../src/config/writer.ts';
import { loadConfigs } from '../src/config/loader.ts';
import { NativeBuildSession } from '../src/adapters/native-build.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'baton-native-'));
}

function writeIos(root: string, opts: { workspace?: boolean; schemes?: string[]; pods?: boolean } = {}) {
  mkdirSync(root, { recursive: true });
  const proj = join(root, 'Demo.xcodeproj', 'xcshareddata', 'xcschemes');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(root, 'Demo.xcodeproj', 'project.pbxproj'), '// pbx');
  for (const scheme of opts.schemes ?? ['Demo']) {
    writeFileSync(join(proj, `${scheme}.xcscheme`), '<Scheme/>');
  }
  if (opts.workspace) mkdirSync(join(root, 'Demo.xcworkspace'), { recursive: true });
  if (opts.pods) mkdirSync(join(root, 'Pods.xcodeproj'), { recursive: true });
}

function writeAndroidApp(root: string, module = 'app', groovy = false) {
  mkdirSync(root, { recursive: true });
  const settings = groovy ? 'settings.gradle' : 'settings.gradle.kts';
  const build = groovy ? 'build.gradle' : 'build.gradle.kts';
  writeFileSync(join(root, settings), groovy ? "include ':app'" : 'include(":app")');
  writeFileSync(join(root, 'gradlew'), '#!/bin/sh');
  mkdirSync(join(root, module), { recursive: true });
  writeFileSync(
    join(root, module, build),
    groovy ? "apply plugin: 'com.android.application'" : 'plugins { id("com.android.application") }',
  );
  mkdirSync(join(root, module, 'src', 'main'), { recursive: true });
  writeFileSync(join(root, module, 'src', 'main', 'AndroidManifest.xml'), '<manifest/>');
}

test('iOS project-only, workspace, Pods, missing schemes and selection paths', () => {
  const root = scratch();
  writeIos(root, { schemes: [] });
  let [target] = detectTargets(root);
  assert.equal(target.kind, 'ios');
  assert.equal(target.name, 'iOS Simulator · Demo');
  assert.equal(target.args?.[0], '-project');

  writeIos(root, { workspace: true, schemes: ['Demo Dev', 'Demo Prod'], pods: true });
  const targets = detectTargets(root);
  assert.deepEqual(targets.map((t) => t.name), ['iOS Simulator · Demo Dev', 'iOS Simulator · Demo Prod']);
  assert.equal(targets[0].args?.[0], '-workspace');
  assert.ok(!targets.some((t) => t.args?.includes('Pods.xcodeproj')));

  const scheme = join(root, 'Demo.xcodeproj', 'xcshareddata', 'xcschemes', 'Demo Dev.xcscheme');
  const pbx = join(root, 'Demo.xcodeproj', 'project.pbxproj');
  for (const path of [root, join(root, 'Demo.xcodeproj'), pbx, scheme]) {
    assert.equal(findProjectRoot(path), root, path);
  }
  assert.equal(isProjectRoot(root), true);
  assert.equal(isNativeProjectSelection(pbx), true);
  assert.equal(isNativeProjectSelection(join(root, 'Demo.xcworkspace')), true);
  rmSync(root, { recursive: true, force: true });
});

test('Android groovy, kts, root module, library-only and nested manifest selection', () => {
  const kts = scratch();
  writeAndroidApp(kts);
  const [app] = detectTargets(kts);
  assert.equal(app.kind, 'android');
  assert.deepEqual(app.args, [':app:installDebug']);
  const manifest = join(kts, 'app', 'src', 'main', 'AndroidManifest.xml');
  assert.equal(findProjectRoot(manifest), kts);
  assert.equal(findProjectRoot(join(kts, 'app', 'build.gradle.kts')), kts);
  assert.equal(isNativeProjectSelection(manifest), true);
  rmSync(kts, { recursive: true, force: true });

  const groovy = scratch();
  writeAndroidApp(groovy, 'app', true);
  assert.deepEqual(detectTargets(groovy)[0].args, [':app:installDebug']);
  rmSync(groovy, { recursive: true, force: true });

  const rootApp = scratch();
  writeFileSync(join(rootApp, 'gradlew'), '#!/bin/sh');
  writeFileSync(join(rootApp, 'build.gradle'), "plugins { id 'com.android.application' }");
  const [single] = detectTargets(rootApp);
  assert.equal(single.name, `Android · ${rootApp.split(/[/\\]/).pop()} debug`);
  assert.deepEqual(single.args, ['installDebug']);
  rmSync(rootApp, { recursive: true, force: true });

  const lib = scratch();
  writeFileSync(join(lib, 'settings.gradle.kts'), 'include(":core")');
  mkdirSync(join(lib, 'core'));
  writeFileSync(join(lib, 'core', 'build.gradle.kts'), 'plugins { id("com.android.library") }');
  assert.equal(detectTargets(lib)[0].name, 'Android · Gradle build');
  rmSync(lib, { recursive: true, force: true });

  const two = scratch();
  writeFileSync(join(two, 'settings.gradle.kts'), 'include(":app", ":wear")');
  writeFileSync(join(two, 'gradlew'), '#!/bin/sh');
  for (const module of ['app', 'wear']) {
    mkdirSync(join(two, module));
    writeFileSync(join(two, module, 'build.gradle.kts'), 'plugins { id("com.android.application") }');
  }
  assert.deepEqual(detectTargets(two).map((t) => t.name), ['Android · app debug', 'Android · wear debug']);
  rmSync(two, { recursive: true, force: true });
});

test('Flutter and React Native roots stay framework runs; nested ios/android are native', () => {
  const flutter = scratch();
  writeFileSync(join(flutter, 'pubspec.yaml'), 'name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n');
  mkdirSync(join(flutter, 'lib'));
  writeFileSync(join(flutter, 'lib', 'main.dart'), 'void main() {}');
  writeIos(join(flutter, 'ios'));
  writeAndroidApp(join(flutter, 'android'));

  const atRoot = detectTargets(flutter);
  assert.equal(atRoot.length, 1);
  assert.equal(atRoot[0].kind, 'flutter');
  assert.equal(detectTargets(join(flutter, 'ios'))[0].kind, 'ios');
  assert.equal(detectTargets(join(flutter, 'android'))[0].kind, 'android');
  assert.equal(findProjectRoot(join(flutter, 'ios', 'Demo.xcodeproj')), join(flutter, 'ios'));
  assert.equal(findProjectRoot(join(flutter, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')), join(flutter, 'android'));

  const report = inspectProject(flutter);
  assert.deepEqual(report.children.map((c) => c.name).sort(), ['android', 'ios']);
  rmSync(flutter, { recursive: true, force: true });

  const rn = scratch();
  writeFileSync(join(rn, 'package.json'), JSON.stringify({
    scripts: { start: 'react-native start' },
    dependencies: { 'react-native': '0.76.0' },
  }));
  writeIos(join(rn, 'ios'));
  writeAndroidApp(join(rn, 'android'));
  assert.equal(detectTargets(rn)[0].kind, 'react-native');
  assert.equal(detectTargets(join(rn, 'ios'))[0].kind, 'ios');
  rmSync(rn, { recursive: true, force: true });
});

test('Package.swift builds only when there is no Xcode wrapper; Podfile alone needs config', () => {
  const spm = scratch();
  writeFileSync(join(spm, 'Package.swift'), '// swift-tools-version: 6.0');
  const [swift] = detectTargets(spm);
  assert.equal(swift.kind, 'process');
  assert.deepEqual(swift.args, ['build']);
  assert.equal(findProjectRoot(join(spm, 'Package.swift')), spm);
  rmSync(spm, { recursive: true, force: true });

  const both = scratch();
  writeIos(both);
  writeFileSync(join(both, 'Package.swift'), '// swift-tools-version: 6.0');
  assert.ok(detectTargets(both).every((t) => t.kind === 'ios'));
  rmSync(both, { recursive: true, force: true });

  const pods = scratch();
  writeFileSync(join(pods, 'Podfile'), "platform :ios, '17.0'");
  assert.equal(isProjectRoot(pods), true);
  assert.equal(detectTargets(pods).length, 0);
  rmSync(pods, { recursive: true, force: true });
});

test('generated native launch configs round-trip as ios/android kinds', () => {
  const root = scratch();
  writeIos(root, { schemes: ['Demo'] });
  writeAndroidApp(root);
  const text = generateLaunchJson(root);
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), text);
  const configs = loadConfigs(join(root, '.vscode', 'launch.json'), root);
  assert.equal(configs.find((c) => c.name.startsWith('iOS'))?.batonKind, 'ios');
  assert.equal(configs.find((c) => c.name.startsWith('Android'))?.batonKind, 'android');
  const detected = detectTargets(root);
  assert.ok(detected.some((t) => t.kind === 'ios' && t.source === 'launch.json'));
  assert.ok(detected.some((t) => t.kind === 'android' && t.source === 'launch.json'));
  rmSync(root, { recursive: true, force: true });
});

test('native sessions offer restart, stop and screenshots, not hot reload', () => {
  const ios = NativeBuildSession.create('ios', 'iOS Simulator · Demo', {
    command: 'true', args: [], cwd: tmpdir(), deviceId: 'SIM-1',
  });
  assert.equal(ios.kind, 'ios');
  assert.equal(ios.capabilities.has('restartProcess'), true);
  assert.equal(ios.capabilities.has('stop'), true);
  assert.equal(ios.capabilities.has('screenshot'), true);
  assert.equal(ios.capabilities.has('hotReload'), false);
});
