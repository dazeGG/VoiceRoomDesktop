'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { requireMsvcEnv } = require('./msvc-env');

const rootDir = path.join(__dirname, '..');
const nativeDir = path.join(rootDir, 'native', 'overlay');
const binDir = path.join(rootDir, 'native', 'bin');
const HELPER_SMOKE_TIMEOUT_MS = 5000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: options.env || process.env,
    shell: false,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    if (result.error) console.error(`${command}: ${result.error.message}`);
    process.exit(result.status || 1);
  }
}

// --once prints the ready line and at most one snapshot, then exits.
function smokeHelper(output) {
  const result = spawnSync(output, ['--once'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: HELPER_SMOKE_TIMEOUT_MS,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || String(result.error || 'Foreground helper smoke failed.'));
    process.exit(result.status || 1);
  }

  const lines = String(result.stdout || '').split(/\r?\n/).filter((line) => line.trim());
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  });
  if (parsed[0]?.event !== 'ready' || parsed.length > 2 || parsed.some((item) => !item)) {
    console.error('Foreground helper smoke returned invalid output.');
    process.exit(1);
  }
}

function buildWindows(options = {}) {
  const source = path.join(nativeDir, 'windows', 'VoiceRoomForeground.cpp');
  const outputDir = path.join(binDir, 'windows');
  ensureDir(outputDir);

  if (process.platform !== 'win32') {
    const message = 'Windows native foreground helper must be built on Windows with MSVC.';
    if (options.required) {
      console.error(message);
      process.exit(1);
    }
    console.warn(`Skipping optional build: ${message}`);
    return;
  }

  const output = path.join(outputDir, 'VoiceRoomForeground.exe');
  // Without /Fo cl.exe drops the .obj into the cwd, which is the repo root.
  const objectDir = path.join(rootDir, 'native', '.cache', 'obj');
  ensureDir(objectDir);

  run('cl.exe', [
    '/nologo',
    `/Fo:${objectDir}${path.sep}`,
    '/EHsc',
    '/std:c++17',
    '/W4',
    '/O2',
    '/MT',
    '/permissive-',
    '/utf-8',
    '/DUNICODE',
    '/D_UNICODE',
    `/Fe:${output}`,
    source,
    '/link',
    '/SUBSYSTEM:CONSOLE',
    'User32.lib',
    'Dwmapi.lib'
  ], { env: requireMsvcEnv('Windows native foreground helper') });
  smokeHelper(output);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Only Windows has an in-game overlay; other targets have nothing to build.
const targets = process.argv.slice(2);
const requestedTargets = targets.length ? targets : [process.platform === 'win32' ? 'win' : ''];

for (const target of requestedTargets) {
  if (target === 'win' || target === '--win') buildWindows({ required: true });
}
