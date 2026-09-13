'use strict';

const { spawn: nodeSpawn } = require('node:child_process');
const path = require('node:path');
const { parseForegroundPayload } = require('./policies/overlay-games');

function resolveForegroundScript(pathModule = path) {
  return pathModule.join(__dirname, '..', 'native', 'overlay', 'windows', 'foreground.ps1');
}

function createForegroundWatcher({
  platform = process.platform,
  spawn = nodeSpawn,
  parentPid = process.pid,
  scriptPath,
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
    for (const line of lines) {
      const payload = parseForegroundPayload(line);
      if (payload) emit(payload);
    }
  }

  function start() {
    if (platform !== 'win32' || child) return;
    const file = scriptPath || resolveForegroundScript();
    child = spawn('powershell.exe', [
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
  resolveForegroundScript
};
