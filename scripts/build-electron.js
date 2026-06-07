'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const targets = args.filter((arg) => arg !== '--dev');
const electronBuilderBin = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
);

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

run(process.execPath, [path.join(rootDir, 'scripts', 'create-electron-config.js')]);

const env = {
  ...process.env,
  VOICE_ROOM_BUILD_HASH: buildHash,
  VOICE_ROOM_DIST_DIR: dev ? path.join('dist', 'dev', buildHash) : ''
};

run(electronBuilderBin, ['--config', 'electron-builder.config.js', ...targets], { env });

if (!dev) {
  run(process.execPath, [path.join(rootDir, 'scripts', 'clean-dist.js')]);
}
