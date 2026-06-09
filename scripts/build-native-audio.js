'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const nativeDir = path.join(rootDir, 'native', 'audio');
const binDir = path.join(rootDir, 'native', 'bin');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: options.env || process.env,
    shell: false,
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });

  if (result.status !== 0) {
    if (options.optional) return false;
    if (options.quiet) {
      process.stderr.write(result.stderr || result.stdout || '');
    }
    process.stderr.write(`${command} exited with status ${result.status || 1}.\n`);
    process.exit(result.status || 1);
  }
  return true;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildMacOS() {
  const source = path.join(nativeDir, 'macos', 'SafeSystemAudioCapture.swift');
  const outputDir = path.join(binDir, 'macos');
  const output = path.join(outputDir, 'SafeSystemAudioCapture');
  ensureDir(outputDir);
  const moduleCacheDir = path.join(rootDir, 'native', '.cache', 'clang-module-cache');
  ensureDir(moduleCacheDir);
  const env = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCacheDir,
    SWIFT_MODULE_CACHE_PATH: moduleCacheDir
  };

  const commonArgs = [
    '-O',
    '-parse-as-library',
    '-framework', 'AVFoundation',
    '-framework', 'CoreMedia',
    '-framework', 'ScreenCaptureKit'
  ];

  const archOutputs = [
    { arch: 'arm64', target: 'arm64-apple-macos13.0', output: path.join(outputDir, 'SafeSystemAudioCapture-arm64') },
    { arch: 'x86_64', target: 'x86_64-apple-macos13.0', output: path.join(outputDir, 'SafeSystemAudioCapture-x86_64') }
  ];

  const builtArchOutputs = [];
  for (const item of archOutputs) {
    const ok = run('xcrun', [
      'swiftc',
      ...commonArgs,
      '-target', item.target,
      '-o', item.output,
      source
    ], { env, optional: true });
    if (ok) builtArchOutputs.push(item.output);
  }

  if (builtArchOutputs.length === archOutputs.length && run('lipo', ['-create', ...builtArchOutputs, '-output', output], { optional: true })) {
    for (const archOutput of builtArchOutputs) fs.rmSync(archOutput, { force: true });
    fs.chmodSync(output, 0o755);
    return;
  }

  run('xcrun', [
    'swiftc',
    ...commonArgs,
    '-o', output,
    source
  ], { env });
  fs.chmodSync(output, 0o755);
}

function buildWindows(options = {}) {
  const source = path.join(nativeDir, 'windows', 'SafeSystemAudioCapture.cpp');
  const outputDir = path.join(binDir, 'windows');
  ensureDir(outputDir);

  if (process.platform !== 'win32') {
    const message = 'Windows native audio helper must be built on Windows with MSVC.';
    if (options.required) {
      console.error(message);
      process.exit(1);
    }
    console.warn(`Skipping optional build: ${message}`);
    return;
  }

  run('cl.exe', [
    '/nologo',
    '/EHsc',
    '/std:c++17',
    '/O2',
    `/Fe:${path.join(outputDir, 'SafeSystemAudioCapture.exe')}`,
    source,
    'avrt.lib',
    'mmdevapi.lib',
    'ole32.lib',
    'propsys.lib',
    'uuid.lib'
  ]);
}

const targets = process.argv.slice(2);
const requestedTargets = targets.length ? targets : [process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : ''];

for (const target of requestedTargets) {
  if (target === 'mac' || target === '--mac') buildMacOS();
  if (target === 'win' || target === '--win') buildWindows({ required: true });
}
