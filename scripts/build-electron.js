'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { resolveMsvcEnv } = require('./msvc-env');

const rootDir = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const targets = args.filter((arg) => arg !== '--dev');
const electronBuilderCli = path.join(rootDir, 'node_modules', 'electron-builder', 'cli.js');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: rootDir,
    env: options.env || process.env,
    shell: false,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    if (result.error) console.error(`${command}: ${result.error.message}`);
    process.exit(result.status || 1);
  }
}

// Load MSVC once for the three native helper builds instead of once per script.
function nativeBuildEnv() {
  const buildsWindows = targets.length === 0
    ? process.platform === 'win32'
    : targets.some((target) => target === '--win' || target === 'win');
  if (process.platform !== 'win32' || !buildsWindows) return process.env;

  const msvc = resolveMsvcEnv();
  if (!msvc.env) {
    console.error(msvc.error);
    process.exit(1);
  }
  if (msvc.source !== 'PATH') console.log(`Using MSVC from ${msvc.source}`);
  return msvc.env;
}

function readGitHash() {
  const hash = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).stdout.trim();
  if (!hash) return 'dev';

  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).stdout.trim();

  return status ? `${hash}-dirty` : hash;
}

const buildHash = dev ? readGitHash() : '';
const buildProfilePath = path.join(rootDir, 'electron', 'build-profile.json');

fs.writeFileSync(
  buildProfilePath,
  `${JSON.stringify(dev ? { buildHash, channel: 'dev' } : { channel: 'release' }, null, 2)}\n`
);

run(process.execPath, [path.join(rootDir, 'scripts', 'create-electron-config.js')]);
const nativeEnv = nativeBuildEnv();
run(process.execPath, [path.join(rootDir, 'scripts', 'build-native-audio.js'), ...targets], { env: nativeEnv });
run(process.execPath, [path.join(rootDir, 'scripts', 'build-native-capture.js'), ...targets], { env: nativeEnv });
const hotkeyTargets = [...targets];
if (
  process.platform === 'darwin'
  && (targets.length === 0 || targets.includes('--mac') || targets.includes('mac'))
) hotkeyTargets.push('--require-universal');
run(process.execPath, [path.join(rootDir, 'scripts', 'build-native-hotkeys.js'), ...hotkeyTargets], { env: nativeEnv });

const env = {
  ...process.env,
  VOICE_ROOM_BUILD_HASH: buildHash,
  VOICE_ROOM_DEV_BUILD: dev ? '1' : '',
  VOICE_ROOM_DIST_DIR: dev ? path.join('dist', 'dev', buildHash) : ''
};

run(process.execPath, [electronBuilderCli, '--config', 'electron-builder.config.js', '--publish', 'never', ...targets], { env });

if (process.platform === 'win32' && env.VOICE_ROOM_NATIVE_CAPTURE_SMOKE === '1') {
  const packagedHelperPath = path.join(
    rootDir,
    env.VOICE_ROOM_DIST_DIR || 'dist',
    'win-unpacked',
    'resources',
    'app.asar.unpacked',
    'native',
    'bin',
    'windows',
    'ScreenCursorCapture.exe'
  );
  run(process.execPath, [
    path.join(rootDir, 'scripts', 'windows-native-capture-smoke.js'),
    '--helper',
    packagedHelperPath
  ], { env });
}

// Prune intermediate build output (unpacked app dirs, helper binaries, debug
// files) down to the publishable artifacts. clean-dist reads VOICE_ROOM_DIST_DIR
// and VOICE_ROOM_DEV_BUILD from env, so it handles both dev and stable output.
run(process.execPath, [path.join(rootDir, 'scripts', 'clean-dist.js')], { env });
