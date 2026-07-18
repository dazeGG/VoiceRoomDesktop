#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FRAME_HEADER_BYTES = 24;
const FRAME_MAGIC = 0x31465256;
const FRAME_FLAG_NV12 = 1 << 1;
const POLL_INTERVAL_MS = 20;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

function fail(message, detail = '') {
  const error = new Error(detail ? `${message}: ${detail}` : message);
  error.name = 'WindowsNativeCaptureSmokeError';
  throw error;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getTaskkillPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'taskkill.exe');
}

async function waitFor(check, label, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`Timed out waiting for ${label}`);
}

async function terminateChildProcess(child, getExit, label) {
  if (getExit()) return getExit();
  try {
    child.kill();
  } catch {
    // The process may have exited between the state check and kill.
  }
  try {
    return await waitFor(getExit, `${label} shutdown`, STOP_TIMEOUT_MS);
  } catch (firstError) {
    if (process.platform === 'win32' && child.pid) {
      spawnSync(getTaskkillPath(), ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: STOP_TIMEOUT_MS,
        windowsHide: true
      });
    }
    try {
      return await waitFor(getExit, `${label} forced shutdown`, STOP_TIMEOUT_MS);
    } catch {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      fail(`Could not reap ${label}`, firstError.message);
    }
  }
}

function appendLineEvents(state, chunk) {
  state.buffer += String(chunk || '');
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      state.events.push(JSON.parse(line));
    } catch {
      state.events.push({ event: 'log', message: line });
    }
  }
}

function framePayloadBytes(width, height, flags) {
  const pixels = width * height;
  return flags & FRAME_FLAG_NV12 ? pixels + Math.floor(pixels / 2) : pixels * 4;
}

function consumeBytes(state, byteCount) {
  if (byteCount === 0) return Buffer.alloc(0);
  if (state.chunks[0].length === byteCount) {
    state.bufferedBytes -= byteCount;
    return state.chunks.shift();
  }
  if (state.chunks[0].length > byteCount) {
    const result = state.chunks[0].subarray(0, byteCount);
    state.chunks[0] = state.chunks[0].subarray(byteCount);
    state.bufferedBytes -= byteCount;
    return result;
  }

  const result = Buffer.allocUnsafe(byteCount);
  let offset = 0;
  while (offset < byteCount) {
    const chunk = state.chunks[0];
    const copyBytes = Math.min(chunk.length, byteCount - offset);
    chunk.copy(result, offset, 0, copyBytes);
    offset += copyBytes;
    if (copyBytes === chunk.length) {
      state.chunks.shift();
    } else {
      state.chunks[0] = chunk.subarray(copyBytes);
    }
  }
  state.bufferedBytes -= byteCount;
  return result;
}

function discardBytes(state, byteCount) {
  let remaining = byteCount;
  while (remaining > 0) {
    const chunk = state.chunks[0];
    const discard = Math.min(chunk.length, remaining);
    remaining -= discard;
    if (discard === chunk.length) {
      state.chunks.shift();
    } else {
      state.chunks[0] = chunk.subarray(discard);
    }
  }
  state.bufferedBytes -= byteCount;
}

function appendFrames(state, chunk) {
  if (!chunk.length) return;
  state.chunks.push(chunk);
  state.bufferedBytes += chunk.length;

  while (true) {
    if (!state.pendingFrame) {
      if (state.bufferedBytes < FRAME_HEADER_BYTES) return;
      const header = consumeBytes(state, FRAME_HEADER_BYTES);
      const magic = header.readUInt32LE(0);
      if (magic !== FRAME_MAGIC) fail('Native capture emitted an invalid frame magic', `0x${magic.toString(16)}`);

      const width = header.readUInt32LE(4);
      const height = header.readUInt32LE(8);
      const flags = header.readUInt32LE(12);
      if (!width || !height || width > 16_384 || height > 16_384) {
        fail('Native capture emitted invalid frame geometry', `${width}x${height}`);
      }
      state.pendingFrame = {
        flags,
        height,
        payloadBytes: framePayloadBytes(width, height, flags),
        width
      };
    }

    if (state.bufferedBytes < state.pendingFrame.payloadBytes) return;
    discardBytes(state, state.pendingFrame.payloadBytes);
    const { flags, height, width } = state.pendingFrame;
    state.frames.push({ flags, height, width });
    state.pendingFrame = null;
  }
}

function createCaptureProcess(helperPath, sourceId, profile) {
  const child = spawn(helperPath, [
    '--source',
    sourceId,
    '--fps',
    String(profile.fps),
    '--max-width',
    String(profile.maxWidth),
    '--max-height',
    String(profile.maxHeight)
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const stderr = { buffer: '', events: [] };
  const stdout = {
    bufferedBytes: 0,
    chunks: [],
    frames: [],
    pendingFrame: null
  };
  const state = {
    child,
    error: null,
    exit: null,
    stderr,
    stdout
  };

  child.stdout.on('data', (chunk) => {
    try {
      appendFrames(stdout, chunk);
    } catch (error) {
      state.error = error;
    }
  });
  child.stderr.on('data', (chunk) => appendLineEvents(stderr, chunk));
  child.stdin.on('error', (error) => {
    state.error = error;
  });
  child.on('error', (error) => {
    state.error = error;
  });
  child.on('exit', (code, signal) => {
    state.exit = { code, signal };
  });

  return state;
}

function assertCaptureAlive(state) {
  if (state.error) throw state.error;
  if (state.exit) {
    const events = JSON.stringify(state.stderr.events.slice(-8));
    fail('Native capture helper exited before the smoke completed', `${JSON.stringify(state.exit)} ${events}`);
  }
  return true;
}

function writeCommand(state, payload) {
  assertCaptureAlive(state);
  if (!state.child.stdin.writable) fail('Native capture stdin is not writable');
  state.child.stdin.write(`${JSON.stringify(payload)}\n`);
}

async function stopThroughFramePipe(state) {
  if (state.exit) return state.exit;

  // Closing the reader makes the next frame write fail. The helper must then
  // unwind the real capture session, drain WGC callbacks, and exit cleanly.
  state.child.stdout.destroy();
  let exit;
  try {
    exit = await waitFor(() => state.exit, 'native helper shutdown', STOP_TIMEOUT_MS);
  } catch (error) {
    try {
      await terminateChildProcess(state.child, () => state.exit, 'native helper');
    } catch (cleanupError) {
      cleanupError.cause = error;
      throw cleanupError;
    }
    throw error;
  }
  if (exit.code !== 0) {
    fail('Native capture helper did not stop cleanly after its frame pipe closed', JSON.stringify(exit));
  }
  return exit;
}

async function runCaptureLifecycle(helperPath, sourceId, iteration) {
  const state = createCaptureProcess(helperPath, sourceId, {
    fps: 30,
    maxHeight: 1080,
    maxWidth: 1920
  });

  try {
    await waitFor(() => {
      assertCaptureAlive(state);
      return state.stdout.frames[0];
    }, `initial frame for iteration ${iteration}`);
    const initialFrame = state.stdout.frames[0];
    if (initialFrame.width > 1920 || initialFrame.height > 1080) {
      fail('Initial native frame exceeded the high profile ceiling', `${initialFrame.width}x${initialFrame.height}`);
    }
    if (initialFrame.width <= 1280 && initialFrame.height <= 720) {
      fail('Windows smoke target did not exceed the balanced profile ceiling', `${initialFrame.width}x${initialFrame.height}`);
    }

    const requestId = iteration;
    writeCommand(state, {
      cmd: 'reconfigure',
      fps: 5,
      maxHeight: 720,
      maxWidth: 1280,
      requestId
    });
    const reconfigured = await waitFor(() => {
      assertCaptureAlive(state);
      return state.stderr.events.find((event) => event.event === 'reconfigured' && event.requestId === requestId);
    }, `reconfigure ACK for iteration ${iteration}`);
    if (reconfigured.fps !== 5 || reconfigured.maxWidth !== 1280 || reconfigured.maxHeight !== 720) {
      fail('Native helper acknowledged the wrong profile', JSON.stringify(reconfigured));
    }

    const frameCountBeforeBalanced = state.stdout.frames.length;
    const balancedFrame = await waitFor(() => {
      assertCaptureAlive(state);
      return state.stdout.frames.slice(frameCountBeforeBalanced)
        .find((frame) => frame.width <= 1280 && frame.height <= 720);
    }, `balanced frame for iteration ${iteration}`);
    if (!balancedFrame) fail('Native helper did not emit a balanced-profile frame');
    if (balancedFrame.width === initialFrame.width && balancedFrame.height === initialFrame.height) {
      fail('Native helper did not change geometry after balanced reconfigure');
    }

    const activeFlowStart = state.stdout.frames.length;
    await waitFor(() => {
      assertCaptureAlive(state);
      return state.stdout.frames.length >= activeFlowStart + 3;
    }, `active pre-pause frame flow for iteration ${iteration}`, 1500);

    writeCommand(state, { cmd: 'set-paused', paused: true });
    await sleep(400);
    assertCaptureAlive(state);
    const settledPausedCount = state.stdout.frames.length;
    await sleep(700);
    assertCaptureAlive(state);
    if (state.stdout.frames.length !== settledPausedCount) {
      fail('Native helper kept emitting frames while paused', `${settledPausedCount} -> ${state.stdout.frames.length}`);
    }

    writeCommand(state, { cmd: 'set-paused', paused: false });
    await waitFor(() => {
      assertCaptureAlive(state);
      return state.stdout.frames.length >= settledPausedCount + 2;
    }, `resumed frame flow for iteration ${iteration}`, 1500);

    await stopThroughFramePipe(state);
    return {
      balanced: `${balancedFrame.width}x${balancedFrame.height}`,
      frames: state.stdout.frames.length,
      initial: `${initialFrame.width}x${initialFrame.height}`
    };
  } finally {
    if (!state.exit) await terminateChildProcess(state.child, () => state.exit, 'native helper');
  }
}

async function runRelayTerminationLifecycle(helperPath, sourceId, terminationMode) {
  const electronPath = require('electron');
  const fixturePath = path.join(
    __dirname,
    '..',
    'test',
    'fixtures',
    'native-capture-relay-termination-electron.js'
  );
  const env = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    VOICE_ROOM_CAPTURE_HELPER: helperPath,
    VOICE_ROOM_RELAY_TERMINATION_MODE: terminationMode,
    VOICE_ROOM_CAPTURE_SOURCE: sourceId
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, [fixturePath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let error = null;
  let exit = null;
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', (spawnError) => { error = spawnError; });
  child.on('exit', (code, signal) => { exit = { code, signal }; });

  try {
    await waitFor(() => {
      if (error) throw error;
      return exit;
    }, 'Electron relay termination fixture', 20_000);
  } finally {
    if (!exit) await terminateChildProcess(child, () => exit, 'Electron relay termination fixture');
  }
  if (exit.code !== 0 || !stdout.includes('native-capture-relay-termination-ok')) {
    fail(
      'Native capture relay termination lifecycle failed',
      [JSON.stringify(exit), stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
    );
  }
  return stdout.trim();
}

async function createWindowCaptureTarget() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    '$form = New-Object System.Windows.Forms.Form',
    "$form.Text = 'Voice Room native capture smoke'",
    '$form.Width = 1600',
    '$form.Height = 900',
    '$form.StartPosition = "Manual"',
    '$form.Left = 0',
    '$form.Top = 0',
    '$label = New-Object System.Windows.Forms.Label',
    '$label.Dock = [System.Windows.Forms.DockStyle]::Fill',
    '$label.Font = New-Object System.Drawing.Font("Arial", 48)',
    '$label.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter',
    '$form.Controls.Add($label)',
    '$state = @{ Counter = 0 }',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 50',
    '$timer.Add_Tick({',
    '  $state.Counter += 1',
    '  $label.Text = "Voice Room frame $($state.Counter)"',
    '  $red = ($state.Counter * 17) % 256',
    '  $green = ($state.Counter * 29) % 256',
    '  $blue = ($state.Counter * 43) % 256',
    '  $label.BackColor = [System.Drawing.Color]::FromArgb($red, $green, $blue)',
    '})',
    '$form.Add_FormClosed({ $timer.Stop() })',
    '$form.Show()',
    '[Console]::Out.WriteLine([Int64]$form.Handle)',
    '[Console]::Out.Flush()',
    '$timer.Start()',
    '[System.Windows.Forms.Application]::Run($form)'
  ].join('\n');
  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  });
  let stdout = '';
  let stderr = '';
  let exit = null;
  let spawnError = null;
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });
  child.on('error', (error) => {
    spawnError = error;
  });

  let handle;
  try {
    handle = await waitFor(() => {
      if (spawnError) throw spawnError;
      if (exit) fail('Windows smoke target exited before publishing its HWND', `${JSON.stringify(exit)} ${stderr}`);
      const line = stdout.split(/\r?\n/).find((value) => /^\d+$/.test(value.trim()));
      return line ? Number(line.trim()) : 0;
    }, 'Windows smoke target HWND');
    if (!Number.isSafeInteger(handle) || handle <= 0) {
      fail('Windows smoke target returned an invalid HWND', String(handle));
    }
  } catch (error) {
    try {
      await terminateChildProcess(child, () => exit, 'Windows smoke target');
    } catch (cleanupError) {
      cleanupError.cause = error;
      throw cleanupError;
    }
    throw error;
  }

  return {
    child,
    handle,
    stop: () => terminateChildProcess(child, () => exit, 'Windows smoke target')
  };
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Windows native capture runtime smoke is only executed on Windows.');
    return;
  }

  const helperPath = path.resolve(readArg('--helper') || path.join(
    __dirname,
    '..',
    'native',
    'bin',
    'windows',
    'ScreenCursorCapture.exe'
  ));
  if (!fs.existsSync(helperPath)) fail('Windows native capture helper is missing', helperPath);

  const target = await createWindowCaptureTarget();
  try {
    const results = [];
    // Repeated real WGC lifecycles exercise callback drain and resource teardown,
    // not just compilation or source-shape assertions.
    for (let iteration = 1; iteration <= 2; iteration += 1) {
      results.push(await runCaptureLifecycle(helperPath, `window:${target.handle}`, iteration));
    }
    const relayTermination = {};
    for (const terminationMode of ['relay-kill', 'tree-kill']) {
      relayTermination[terminationMode] = await runRelayTerminationLifecycle(
        helperPath,
        `window:${target.handle}`,
        terminationMode
      );
    }
    console.log(`Windows native capture runtime smoke passed: ${JSON.stringify({
      relayTermination,
      results
    })}`);
  } finally {
    await target.stop();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
