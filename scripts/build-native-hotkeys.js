'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const nativeDir = path.join(rootDir, 'native', 'hotkeys');
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
    if (options.quiet) process.stderr.write(result.stderr || result.stdout || '');
    process.exit(result.status || 1);
  }
  return true;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildMacOS(options = {}) {
  const source = path.join(nativeDir, 'macos', 'VoiceRoomHotkeys.swift');
  const outputDir = path.join(binDir, 'macos');
  const output = path.join(outputDir, 'VoiceRoomHotkeys');
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
    '-warnings-as-errors',
    '-parse-as-library',
    '-framework', 'Carbon',
    '-framework', 'CoreGraphics'
  ];
  const minimumMacOSTarget = '12.0';
  const archOutputs = [
    {
      output: path.join(outputDir, 'VoiceRoomHotkeys-arm64'),
      target: `arm64-apple-macos${minimumMacOSTarget}`
    },
    {
      output: path.join(outputDir, 'VoiceRoomHotkeys-x86_64'),
      target: `x86_64-apple-macos${minimumMacOSTarget}`
    }
  ];
  for (const item of archOutputs) fs.rmSync(item.output, { force: true });
  fs.rmSync(output, { force: true });
  const builtArchOutputs = [];
  for (const item of archOutputs) {
    const ok = run('xcrun', [
      'swiftc',
      ...commonArgs,
      '-target', item.target,
      '-o', item.output,
      source
    ], { env, optional: true, quiet: true });
    if (ok) builtArchOutputs.push(item.output);
  }

  if (
    builtArchOutputs.length === archOutputs.length
    && run('lipo', ['-create', ...builtArchOutputs, '-output', output], { optional: true, quiet: true })
    && run('lipo', ['-verify_arch', 'arm64', 'x86_64', output], { optional: true, quiet: true })
  ) {
    for (const archOutput of builtArchOutputs) fs.rmSync(archOutput, { force: true });
    fs.chmodSync(output, 0o755);
    return;
  }

  for (const archOutput of builtArchOutputs) fs.rmSync(archOutput, { force: true });
  fs.rmSync(output, { force: true });
  if (options.requireUniversal) {
    console.error('A universal arm64+x86_64 macOS hotkey helper is required for dual-architecture packaging.');
    process.exit(1);
  }
  console.warn('Universal macOS hotkey helper build is unavailable; building the current host architecture.');
  const hostTarget = `${process.arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos${minimumMacOSTarget}`;
  run('xcrun', ['swiftc', ...commonArgs, '-target', hostTarget, '-o', output, source], { env });
  fs.chmodSync(output, 0o755);
}

function buildWindows(options = {}) {
  const source = path.join(nativeDir, 'windows', 'VoiceRoomHotkeys.cpp');
  const outputDir = path.join(binDir, 'windows');
  ensureDir(outputDir);

  if (process.platform !== 'win32') {
    const message = 'Windows native hotkey helper must be built on Windows with MSVC.';
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
    '/W4',
    '/O2',
    '/MT',
    '/permissive-',
    '/utf-8',
    '/DUNICODE',
    '/D_UNICODE',
    `/Fe:${path.join(outputDir, 'VoiceRoomHotkeys.exe')}`,
    source,
    '/link',
    '/SUBSYSTEM:CONSOLE',
    'User32.lib'
  ]);
}

const requireUniversal = process.argv.includes('--require-universal');
const targets = process.argv.slice(2).filter((target) => target !== '--require-universal');
const requestedTargets = targets.length
  ? targets
  : [process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : ''];

for (const target of requestedTargets) {
  if (target === 'mac' || target === '--mac') buildMacOS({ requireUniversal });
  if (target === 'win' || target === '--win') buildWindows({ required: true });
}
