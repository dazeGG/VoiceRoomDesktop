'use strict';

const { spawn: nodeSpawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseForegroundPayload } = require('./policies/overlay-games');

const SCRIPT_RELATIVE = path.join('native', 'overlay', 'windows', 'foreground.ps1');
const NATIVE_HELPER_RELATIVE = path.join('native', 'bin', 'windows', 'VoiceRoomForeground.exe');
const RESTART_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000, 60_000]);
// A native helper that dies this many times before its first report is treated
// as blocked (antivirus, missing runtime) and the PowerShell script takes over.
const NATIVE_FAILURES_BEFORE_FALLBACK = 2;

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

// The event-driven helper is preferred: no PowerShell start-up cost, no Add-Type
// (which AppLocker and Constrained Language Mode block) and per-monitor DPI aware
// window bounds.
function resolveNativeForegroundHelper({
  appPath = '',
  resourcesPath = '',
  fs: fsModule = fs,
  path: pathModule = path
} = {}) {
  const candidates = [
    pathModule.join(resourcesPath, 'app.asar.unpacked', NATIVE_HELPER_RELATIVE),
    pathModule.join(resourcesPath, NATIVE_HELPER_RELATIVE),
    pathModule.join(appPath, NATIVE_HELPER_RELATIVE),
    pathModule.join(__dirname, '..', NATIVE_HELPER_RELATIVE)
  ];
  return candidates.find((candidate) => (
    !isInsideAsar(candidate, pathModule) && fsModule.existsSync(candidate)
  )) || '';
}

function createForegroundWatcher({
  platform = process.platform,
  spawn = nodeSpawn,
  parentPid = process.pid,
  scriptPath,
  nativeHelperPath,
  appPath = '',
  resourcesPath = '',
  tempPath = '',
  env = process.env,
  fs: fsModule = fs,
  path: pathModule = path,
  onChange,
  log = console,
  intervalMs = 400
} = {}) {
  let child = null;
  let buffer = '';
  let running = false;
  let failures = 0;
  let restartTimer = null;
  let nativeFailures = 0;
  let reported = false;
  let backend = 'none';

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
      if (!payload) continue;
      failures = 0;
      reported = true;
      emit(payload);
    }
  }

  function resolveScript() {
    if (scriptPath) return scriptPath;
    try {
      return resolveRunnableForegroundScript({
        appPath,
        fs: fsModule,
        path: pathModule,
        resourcesPath,
        tempPath: tempPath || os.tmpdir()
      });
    } catch (error) {
      log.warn?.('Foreground watcher script could not be prepared:', error);
      return '';
    }
  }

  function scheduleRestart(reason) {
    if (!running || restartTimer) return;
    const delay = RESTART_DELAYS_MS[Math.min(failures, RESTART_DELAYS_MS.length - 1)];
    failures += 1;
    log.warn?.(`Foreground watcher stopped (${reason}); restarting in ${delay} ms.`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (running && !child) spawnWatcher();
    }, delay);
    restartTimer.unref?.();
  }

  function resolveNativeHelper() {
    if (env.VOICE_ROOM_NATIVE_FOREGROUND === '0') return '';
    if (nativeFailures >= NATIVE_FAILURES_BEFORE_FALLBACK) return '';
    if (nativeHelperPath !== undefined) return nativeHelperPath || '';
    try {
      return resolveNativeForegroundHelper({ appPath, fs: fsModule, path: pathModule, resourcesPath });
    } catch {
      return '';
    }
  }

  function resolveCommand() {
    const helper = resolveNativeHelper();
    if (helper) {
      return { args: ['--parent-pid', String(parentPid)], backend: 'native', command: helper };
    }

    const file = resolveScript();
    if (!file) {
      log.warn?.('Foreground watcher script is missing; overlay will not detect games.');
      return null;
    }
    if (isInsideAsar(file, pathModule)) {
      log.warn?.('Foreground watcher script is inside asar and cannot be executed:', file);
      return null;
    }
    return {
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', file,
        '-ParentPid', String(parentPid),
        '-IntervalMs', String(intervalMs)
      ],
      backend: 'powershell',
      command: powershellExecutable()
    };
  }

  function spawnWatcher() {
    const resolved = resolveCommand();
    if (!resolved) {
      backend = 'none';
      running = false;
      return;
    }

    let proc;
    try {
      proc = spawn(resolved.command, resolved.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      log.warn?.('Foreground watcher failed to start:', error);
      noteNativeFailure(resolved.backend);
      scheduleRestart('spawn failed');
      return;
    }

    child = proc;
    buffer = '';
    reported = false;
    backend = resolved.backend;
    // A late event from a replaced helper must not clear the current one.
    const finish = (reason) => {
      if (child !== proc) return;
      child = null;
      if (!reported) noteNativeFailure(resolved.backend);
      scheduleRestart(reason);
    };
    proc.stdout?.on?.('data', (chunk) => {
      if (child === proc) handleChunk(chunk);
    });
    proc.stderr?.on?.('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log.warn?.('Foreground watcher:', text);
    });
    proc.on?.('error', (error) => {
      log.warn?.('Foreground watcher failed:', error);
      finish('error');
    });
    proc.on?.('exit', (code, signal) => finish(`exit ${code ?? signal ?? 'unknown'}`));
  }

  function noteNativeFailure(failedBackend) {
    if (failedBackend !== 'native') return;
    nativeFailures += 1;
    if (nativeFailures === NATIVE_FAILURES_BEFORE_FALLBACK) {
      log.warn?.('Native foreground helper keeps failing; switching to the PowerShell watcher.');
    }
  }

  function start() {
    if (platform !== 'win32' || running) return;
    running = true;
    failures = 0;
    spawnWatcher();
  }

  function stop() {
    running = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const proc = child;
    child = null;
    buffer = '';
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // The watcher is best-effort; the script also exits once Voice Room is gone.
    }
  }

  return {
    getStatus: () => ({ backend, failures, running }),
    start,
    stop
  };
}

module.exports = {
  NATIVE_FAILURES_BEFORE_FALLBACK,
  RESTART_DELAYS_MS,
  createForegroundWatcher,
  isInsideAsar,
  resolveForegroundScript,
  resolveNativeForegroundHelper,
  resolveRunnableForegroundScript
};
