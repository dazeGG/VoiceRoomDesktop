'use strict';

const { app, MessageChannelMain, utilityProcess } = require('electron');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  NATIVE_CAPTURE_PROTOCOL_VERSION
} = require('../../electron/native/capture-contract');

const HELPER_LOOKUP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const SHUTDOWN_TIMEOUT_MS = 5000;

let completed = false;
let helperPid = 0;
let port = null;
let relay = null;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function taskkill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const taskkillPath = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  return spawnSync(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    timeout: SHUTDOWN_TIMEOUT_MS,
    windowsHide: true
  });
}

function findHelperPid(parentPid) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return 0;
  const command = [
    `$process = Get-CimInstance Win32_Process -Filter \"ParentProcessId = ${parentPid}\"`,
    "$process | Where-Object { $_.Name -eq 'ScreenCursorCapture.exe' } | Select-Object -First 1 -ExpandProperty ProcessId"
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command
  ], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect relay child processes: ${String(result.stderr || '').trim()}`);
  }
  const pid = Number.parseInt(String(result.stdout || '').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function finish(code, message) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  try { port?.close(); } catch {}
  if (code !== 0) {
    taskkill(relay?.pid);
    try {
      if (isProcessRunning(helperPid)) taskkill(helperPid);
    } catch {
      taskkill(helperPid);
    }
  }
  const output = code === 0 ? process.stdout : process.stderr;
  output.write(`${message}\n`, () => app.exit(code));
}

const fail = (error) => finish(1, String(error?.stack || error));
const timeout = setTimeout(() => fail(new Error('Native capture relay termination fixture timed out.')), 15000);

async function run() {
  const helperPath = String(process.env.VOICE_ROOM_CAPTURE_HELPER || '');
  const terminationMode = String(process.env.VOICE_ROOM_RELAY_TERMINATION_MODE || 'relay-kill');
  const sourceId = String(process.env.VOICE_ROOM_CAPTURE_SOURCE || '');
  if (!helperPath || !sourceId) throw new Error('Native capture relay fixture arguments are missing.');
  if (!['relay-kill', 'tree-kill'].includes(terminationMode)) {
    throw new Error(`Unsupported relay termination mode: ${terminationMode}`);
  }

  const relayEntry = path.join(__dirname, '..', '..', 'electron', 'native', 'capture-relay.js');
  relay = utilityProcess.fork(relayEntry, [], {
    serviceName: 'Voice Room Native Capture Relay Termination Fixture',
    stdio: 'ignore'
  });
  const channel = new MessageChannelMain();
  port = channel.port1;
  const state = {
    error: null,
    frameCount: 0,
    relayExit: null
  };

  port.on('message', (event) => {
    if (event.data?.type === 'frame') state.frameCount += 1;
    if (event.data?.type === 'end') {
      state.error = new Error(`Capture ended before relay termination: ${JSON.stringify(event.data)}`);
    }
  });
  port.start();
  relay.on('error', (type, location) => {
    state.error = new Error(`Relay error: ${type}${location ? ` at ${location}` : ''}`);
  });
  relay.on('exit', (code) => {
    state.relayExit = { code };
  });
  relay.postMessage({
    fps: 30,
    helperPath,
    maxHeight: 1080,
    maxWidth: 1920,
    protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
    qualityId: 'high',
    sourceId,
    type: 'start'
  }, [channel.port2]);

  await waitFor(() => {
    if (state.error) throw state.error;
    return state.frameCount >= 2;
  }, 'relay backpressure pause', HELPER_LOOKUP_TIMEOUT_MS);
  await sleep(400);
  const pausedFrameCount = state.frameCount;
  await sleep(700);
  if (state.error) throw state.error;
  if (state.frameCount !== pausedFrameCount) {
    throw new Error(`Helper did not remain paused: ${pausedFrameCount} -> ${state.frameCount}`);
  }

  const relayPid = relay.pid;
  helperPid = await waitFor(
    () => findHelperPid(relayPid),
    'native helper process',
    HELPER_LOOKUP_TIMEOUT_MS
  );
  if (terminationMode === 'tree-kill') {
    const result = taskkill(relayPid);
    if (result?.error) throw result.error;
    if (!result || result.status !== 0) {
      throw new Error(`taskkill could not terminate the relay tree: ${String(result?.stderr || '').trim()}`);
    }
  } else if (!relay.kill()) {
    throw new Error('Electron rejected the relay termination request.');
  }
  await waitFor(() => state.relayExit, 'relay exit', SHUTDOWN_TIMEOUT_MS);
  await waitFor(() => !isProcessRunning(helperPid), 'paused native helper exit', SHUTDOWN_TIMEOUT_MS);

  finish(0, `native-capture-relay-termination-ok mode=${terminationMode} frames=${pausedFrameCount} helperPid=${helperPid}`);
}

app.whenReady().then(run).catch(fail);
