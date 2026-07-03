'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const nativeDir = path.join(rootDir, 'native', 'capture');
const binDir = path.join(rootDir, 'native', 'bin');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
    stdio: 'inherit'
  });

  if (result.status !== 0) process.exit(result.status || 1);
}

// The cursor-correct capture helper is Windows-only: it exists to work around
// WGC/WebRTC cursor bugs that do not occur on macOS (ScreenCaptureKit honours
// system-level cursor hiding).
function buildWindows(options = {}) {
  const source = path.join(nativeDir, 'windows', 'ScreenCursorCapture.cpp');
  const outputDir = path.join(binDir, 'windows');
  fs.mkdirSync(outputDir, { recursive: true });

  if (process.platform !== 'win32') {
    const message = 'Windows native capture helper must be built on Windows with MSVC.';
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
    '/permissive-',
    '/bigobj',
    '/O2',
    '/DWIN32_LEAN_AND_MEAN',
    '/DNOMINMAX',
    `/Fe:${path.join(outputDir, 'ScreenCursorCapture.exe')}`,
    source,
    'd3d11.lib',
    'dxgi.lib',
    'dwmapi.lib',
    'gdi32.lib',
    'ole32.lib',
    'user32.lib',
    'windowsapp.lib',
    'avrt.lib'
  ]);
}

const targets = process.argv.slice(2);
const requestedTargets = targets.length ? targets : [process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : ''];

for (const target of requestedTargets) {
  if (target === 'win' || target === '--win') buildWindows({ required: true });
  // 'mac' is a no-op: there is no macOS capture helper (see comment above).
}
