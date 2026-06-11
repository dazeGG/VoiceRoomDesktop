'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

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

  if (result.status !== 0) process.exit(result.status || 1);
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
run(process.execPath, [path.join(rootDir, 'scripts', 'build-native-audio.js'), ...targets]);
run(process.execPath, [path.join(rootDir, 'scripts', 'build-native-capture.js'), ...targets]);

const env = {
  ...process.env,
  VOICE_ROOM_BUILD_HASH: buildHash,
  VOICE_ROOM_DEV_BUILD: dev ? '1' : '',
  VOICE_ROOM_DIST_DIR: dev ? path.join('dist', 'dev', buildHash) : ''
};

run(process.execPath, [electronBuilderCli, '--config', 'electron-builder.config.js', '--publish', 'never', ...targets], { env });

// Prune intermediate build output (unpacked app dirs, helper binaries, debug
// files) down to the publishable artifacts. clean-dist reads VOICE_ROOM_DIST_DIR
// and VOICE_ROOM_DEV_BUILD from env, so it handles both dev and stable output.
run(process.execPath, [path.join(rootDir, 'scripts', 'clean-dist.js')], { env });
