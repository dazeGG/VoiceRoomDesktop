'use strict';

const { spawn: nodeSpawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseForegroundPayload } = require('./policies/overlay-games');

const SCRIPT_RELATIVE = path.join('native', 'overlay', 'windows', 'foreground.ps1');

function isInsideAsar(filePath, pathModule = path) {
  const needle = `${pathModule.sep}app.asar${pathModule.sep}`;
  return typeof filePath === 'string' && filePath.includes(needle);
}

function powershellExecutable() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function resolveForegroundScript(pathModule = path) {
  return pathModule.join(__dirname, '..', SCRIPT_RELATIVE);
}

function resolveRunnableForegroundScript({
  appPath = '',
  resourcesPath = '',
  tempPath = '',
  fs: fsModule = fs,
  path: pathModule = path
} = {}) {
  const candidates = [
    pathModule.join(resourcesPath, 'app.asar.unpacked', SCRIPT_RELATIVE),
    pathModule.join(resourcesPath, SCRIPT_RELATIVE),
    pathModule.join(appPath, SCRIPT_RELATIVE),
    resolveForegroundScript(pathModule)
  ].filter(Boolean);

  const unpacked = candidates.find((candidate) => (
    fsModule.existsSync(candidate) && !isInsideAsar(candidate, pathModule)
  ));
  if (unpacked) return unpacked;

  const packed = candidates.find((candidate) => fsModule.existsSync(candidate));
  if (!packed) return '';
  if (!tempPath) return packed;

  const dest = pathModule.join(tempPath, 'voice-room-foreground.ps1');
  fsModule.copyFileSync(packed, dest);
  return dest;
}

function createForegroundWatcher({
  platform = process.platform,
  spawn = nodeSpawn,
  parentPid = process.pid,
  scriptPath,
  appPath = '',
  resourcesPath = '',
  tempPath = '',
  fs: fsModule = fs,
  path: pathModule = path,
  onChange,
  log = console,
  intervalMs = 400
} = {}) {
  let child = null;
  let buffer = '';

  function emit(payload) {
    if (typeof onChange !== 'function') return;
    try {
      onChange(payload);
    } catch (error) {
      log.warn?.('Foreground watcher listener failed:', error);
    }
  }

  function handleChunk(chunk) {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.replace(/^\uFEFF/, '').trim();
      const payload = parseForegroundPayload(line);
      if (payload) emit(payload);
    }
  }

  function start() {
    if (platform !== 'win32' || child) return;
    const file = scriptPath || resolveRunnableForegroundScript({
      appPath,
      fs: fsModule,
      path: pathModule,
      resourcesPath,
      tempPath: tempPath || os.tmpdir()
    });
    if (!file) {
      log.warn?.('Foreground watcher script is missing; overlay will not detect games.');
      return;
    }
    if (isInsideAsar(file, pathModule)) {
      log.warn?.('Foreground watcher script is inside asar and cannot be executed:', file);
      return;
    }

    child = spawn(powershellExecutable(), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', file,
      '-ParentPid', String(parentPid),
      '-IntervalMs', String(intervalMs)
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout?.on?.('data', handleChunk);
    child.stderr?.on?.('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log.warn?.('Foreground watcher:', text);
    });
    child.on?.('error', (error) => {
      log.warn?.('Foreground watcher failed to start:', error);
    });
    child.on?.('exit', (code, signal) => {
      if (code) log.warn?.(`Foreground watcher exited (${code}${signal ? `/${signal}` : ''}).`);
      child = null;
    });
  }

  function stop() {
    const running = child;
    child = null;
    buffer = '';
    if (!running) return;
    try {
      running.kill();
    } catch {
      // The watcher is best-effort; a leftover PowerShell process dies with the app.
    }
  }

  return { start, stop };
}

module.exports = {
  createForegroundWatcher,
  isInsideAsar,
  resolveForegroundScript,
  resolveRunnableForegroundScript
};
