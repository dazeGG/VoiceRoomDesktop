'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const builderConfig = require('../electron-builder.config');
const packageJson = require('../package.json');
const rootDir = path.join(__dirname, '..');
const requiredStartupAssets = [
  'electron/build-profile.json',
  'electron/preload.js',
  'electron/runtime-config.json',
  'electron/shell-tokens.css',
  'electron/native/capture-frames.js',
  'electron/native/capture-relay.js',
  'electron/ui/app-topbar.css',
  'electron/ui/app-topbar.html',
  'electron/ui/renderer-recovery.css',
  'electron/ui/renderer-recovery.html',
  'electron/ui/renderer-recovery.js',
  'electron/ui/screen-picker-preview.css',
  'electron/ui/screen-picker-preview.html',
  'electron/ui/screen-picker.js',
  'electron/ui/screen-picker-preload.js',
  'electron/ui/update-preload.js',
  'electron/ui/update-splash.css',
  'electron/ui/update-splash.html',
  'electron/ui/update-splash.js'
];

function toPackagePath(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function resolveLocalRequire(request, fromFile) {
  const absolute = path.resolve(path.dirname(fromFile), request);
  const candidates = path.extname(absolute)
    ? [absolute]
    : [
        `${absolute}.js`,
        path.join(absolute, 'index.js')
      ];

  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function collectLocalRequireGraph(entryFile, seen = new Set()) {
  const absoluteEntry = path.resolve(entryFile);
  if (seen.has(absoluteEntry)) return seen;
  seen.add(absoluteEntry);

  const source = fs.readFileSync(absoluteEntry, 'utf8');
  const requirePattern = /require\(['"]([^'"]+)['"]\)/g;
  for (const match of source.matchAll(requirePattern)) {
    const request = match[1];
    if (!request.startsWith('./') && !request.startsWith('../')) continue;

    const resolved = resolveLocalRequire(request, absoluteEntry);
    if (!resolved || !resolved.startsWith(path.join(rootDir, 'electron'))) continue;

    collectLocalRequireGraph(resolved, seen);
  }

  return seen;
}

function collectHtmlAssetReferences(htmlFile) {
  const source = fs.readFileSync(htmlFile, 'utf8');
  const assetPattern = /\b(?:href|src)=["']([^"']+)["']/g;
  const assets = [];

  for (const match of source.matchAll(assetPattern)) {
    const assetPath = match[1];
    if (!assetPath.startsWith('./') && !assetPath.startsWith('../')) continue;

    assets.push(toPackagePath(path.resolve(path.dirname(htmlFile), assetPath)));
  }

  return assets;
}

function collectUtilityProcessForkTargets(sourceFile) {
  const source = fs.readFileSync(sourceFile, 'utf8');
  const forkPattern = /utilityProcess\.fork\(path\.join\(__dirname,\s*['"]([^'"]+)['"]\)/g;
  const targets = [];

  for (const match of source.matchAll(forkPattern)) {
    targets.push(toPackagePath(path.resolve(path.dirname(sourceFile), match[1])));
  }

  return targets;
}

function getWorkflowJob(workflow, jobName) {
  const escapedName = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(new RegExp(`(?:^|\\n)  ${escapedName}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9-]+:\\n|$)`));
  assert.ok(match, `Missing workflow job: ${jobName}`);
  return match[1];
}

describe('electron-builder config', () => {
  it('does not disable macOS signing when a release certificate is available', () => {
    assert.equal(Object.hasOwn(builderConfig.mac, 'identity'), false);
  });

  it('does not pair unsigned macOS artifacts with Electron 42 notifications', () => {
    const electronVersion = packageJson.devDependencies.electron.replace(/^[^0-9]*/, '');
    const electronMajor = Number.parseInt(electronVersion.split('.')[0], 10);
    const hasMacSigningIdentity = typeof builderConfig.mac.identity === 'string'
      && builderConfig.mac.identity.trim().length > 0;

    assert.ok(
      hasMacSigningIdentity || electronMajor < 42,
      'Electron 42+ macOS notifications require code signing; configure a signing identity before upgrading.'
    );
  });

  it('uses the Intel macOS runner required for the universal hotkey helper', () => {
    for (const workflowPath of [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml'
    ]) {
      const workflow = fs.readFileSync(path.join(rootDir, workflowPath), 'utf8');
      assert.match(
        workflow,
        /runs-on: macos-15-intel/,
        `${workflowPath} must build macOS artifacts on the Intel runner.`
      );
    }
  });

  it('runs the packaged Windows native capture runtime smoke before pruning build output', () => {
    for (const workflowPath of [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml'
    ]) {
      const workflow = fs.readFileSync(path.join(rootDir, workflowPath), 'utf8');
      const macJob = getWorkflowJob(workflow, 'build-mac');
      const windowsJob = getWorkflowJob(workflow, 'build-windows');
      assert.match(
        windowsJob,
        /VOICE_ROOM_NATIVE_CAPTURE_SMOKE:\s*'1'/,
        `${workflowPath} must enable the runtime smoke inside build-windows.`
      );
      assert.match(macJob, /node --test test\/electron-message-port\.test\.js/);
      assert.match(windowsJob, /node --test test\/electron-message-port\.test\.js/);
    }

    const buildScript = fs.readFileSync(path.join(rootDir, 'scripts/build-electron.js'), 'utf8');
    const runtimeSmoke = fs.readFileSync(path.join(rootDir, 'scripts/windows-native-capture-smoke.js'), 'utf8');
    const packageIndex = buildScript.indexOf("[electronBuilderCli, '--config'");
    const smokeIndex = buildScript.indexOf("'windows-native-capture-smoke.js'");
    const pruneIndex = buildScript.indexOf("'clean-dist.js'");
    assert.ok(packageIndex >= 0 && smokeIndex > packageIndex && pruneIndex > smokeIndex);
    assert.match(buildScript, /win-unpacked[\s\S]*app\.asar\.unpacked[\s\S]*ScreenCursorCapture\.exe/);
    assert.match(runtimeSmoke, /native-capture-relay-termination-electron\.js/);
    assert.match(runtimeSmoke, /VOICE_ROOM_CAPTURE_HELPER:[\s\S]*VOICE_ROOM_CAPTURE_SOURCE:/);
  });

  it('packages native capture utility process modules', () => {
    assert.ok(builderConfig.files.includes('electron/native/capture.js'));
    assert.ok(builderConfig.files.includes('electron/native-capture-contract.js'));
    assert.ok(builderConfig.files.includes('electron/native/capture-contract.js'));
    assert.ok(builderConfig.files.includes('electron/native/capture-frames.js'));
    assert.ok(builderConfig.files.includes('electron/native/capture-relay.js'));
    assert.ok(builderConfig.files.includes('electron/policies/windows-capture.js'));
  });

  it('packages the main-process startup require graph and icon', () => {
    const requiredFiles = [...collectLocalRequireGraph(path.join(rootDir, 'electron/main.js'))]
      .map(toPackagePath)
      .sort();
    const missingFiles = requiredFiles.filter((filePath) => !builderConfig.files.includes(filePath));

    assert.deepEqual(missingFiles, []);
    assert.ok(builderConfig.files.includes('assets/logo/icon.ico'));
  });

  it('packages startup assets loaded outside the require graph', () => {
    const htmlAssets = [
      'electron/ui/renderer-recovery.html',
      'electron/ui/screen-picker-preview.html',
      'electron/ui/update-splash.html'
    ].flatMap((filePath) => collectHtmlAssetReferences(path.join(rootDir, filePath)));
    const utilityProcessEntryPoints = collectUtilityProcessForkTargets(path.join(rootDir, 'electron/native/capture.js'));
    const requiredAssets = [...new Set([...requiredStartupAssets, ...htmlAssets, ...utilityProcessEntryPoints])].sort();
    const missingAssets = requiredAssets.filter((filePath) => !builderConfig.files.includes(filePath));

    assert.deepEqual(missingAssets, []);
  });
});
