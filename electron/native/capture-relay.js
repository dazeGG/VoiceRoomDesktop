'use strict';

const { spawn } = require('node:child_process');

const {
  appendFrameChunk,
  createFrameState
} = require('./capture-frames');
const {
  buildReconfigureStdinPayload,
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  normalizeReconfigureCommand
} = require('./capture-contract');
const { createRestartPolicy } = require('../policies/native-capture-restart');

const STATS_INTERVAL_MS = 2000;
const parentPort = process.parentPort;
let activeSession = null;

function postParent(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    // The main process is gone; the helper will stop once its stdout pipe closes.
  }
}

function log(level, message, detail = undefined) {
  postParent({ detail, level, message, type: 'log' });
}

function postToRenderer(session, message) {
  if (!session || session.stopped || !session.port) return false;
  try {
    // Frame payloads are large (NV12 1080p30 is ~35MB/s); transfer ownership
    // of the ArrayBuffer instead of structured-cloning it on every frame, or
    // this copy competes with the game/encoder for CPU on weaker machines.
    // `message.data` is not read again after this call, so transfer is safe.
    session.port.postMessage(message, message.data ? [message.data] : []);
    if (message.type === 'frame') session.framesPosted += 1;
    return true;
  } catch (error) {
    log('warn', 'Native capture relay port post failed.', { message: String(error?.message || error) });
    stopSession(session, { closePort: true });
    return false;
  }
}

function spawnHelper(session) {
  return spawn(session.helperPath, [
    '--source',
    String(session.sourceId),
    '--fps',
    String(session.fps),
    '--max-height',
    String(session.maxHeight)
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function writeReconfigureToChild(session, command) {
  const payload = buildReconfigureStdinPayload(session, command);
  if (payload.fps) session.fps = payload.fps;
  if (payload.maxHeight) session.maxHeight = payload.maxHeight;

  const child = session.child;
  if (!child?.stdin?.writable) return false;

  try {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    return false;
  }
}

function handleReconfigure(session, message) {
  const command = normalizeReconfigureCommand(message);
  if (!command || !session?.child) return false;
  return writeReconfigureToChild(session, command);
}

function startStatsTimer(session) {
  stopStatsTimer(session);
  session.statsTimer = setInterval(() => {
    if (activeSession !== session || session.stopped) return;
    postToRenderer(session, {
      framesParsed: session.framesParsed,
      framesPosted: session.framesPosted,
      restarts: session.restarts,
      type: 'stats'
    });
  }, STATS_INTERVAL_MS);
  session.statsTimer.unref?.();
}

function stopStatsTimer(session) {
  if (!session?.statsTimer) return;
  clearInterval(session.statsTimer);
  session.statsTimer = null;
}

function attachChild(session, child) {
  session.child = child;

  // A reconfigure write racing the child's death surfaces EPIPE as an async
  // 'error' event on the stdin stream (not a throw writeReconfigureToChild can
  // catch). Without this listener that event would crash the utility process
  // and take the whole capture relay down. The exit handler owns recovery.
  child.stdin.on('error', () => {});

  child.stdout.on('data', (chunk) => {
    if (activeSession !== session || session.stopped) return;
    const result = appendFrameChunk(session.frameState, chunk);
    session.framesParsed += result.frames.length;
    for (const frame of result.frames) {
      postToRenderer(session, frame);
    }
    if (result.error) {
      log('error', result.error.message);
      postToRenderer(session, { reason: result.error.reason, type: 'end' });
      stopSession(session, { closePort: true });
    }
  });

  child.stderr.on('data', (chunk) => {
    if (activeSession !== session || session.stopped) return;
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        event = { event: 'log', message: line };
      }
      if (event.event === 'format') {
        postToRenderer(session, {
          fps: Number(event.fps) || session.fps,
          height: Number(event.height) || 0,
          pixelFormat: event.pixelFormat || '',
          type: 'format',
          width: Number(event.width) || 0
        });
      } else if (event.event === 'error') {
        log('warn', 'Native capture helper error.', event.message || '');
      } else if (event.event === 'warning') {
        log('warn', 'Native capture helper warning.', event.message || '');
      } else if (event.event !== 'exit') {
        log('info', 'Native capture helper.', event.message || event.event);
      }
    }
  });

  child.on('error', (error) => {
    if (activeSession !== session) return;
    log('error', 'Native capture helper process error.', { message: String(error?.message || error) });
    postToRenderer(session, { reason: 'spawn-error', type: 'end' });
    finishSession(session, 'spawn-error');
  });

  child.on('exit', (code, signal) => {
    if (activeSession !== session) return;
    if (session.forceKillTimer) clearTimeout(session.forceKillTimer);

    if (!session.stopped && session.restartPolicy.shouldRestart(code)) {
      session.frameState = createFrameState();
      session.restarts += 1;
      let nextChild = null;
      try {
        nextChild = spawnHelper(session);
      } catch (error) {
        log('error', 'Native capture helper restart failed.', { message: String(error?.message || error) });
      }

      if (nextChild) {
        log('warn', 'Native capture helper crashed; restarting.', {
          attempt: session.restarts,
          code,
          signal
        });
        attachChild(session, nextChild);
        return;
      }
    }

    if (!session.stopped) {
      if (code !== 0 && code !== null) {
        log('warn', 'Native capture helper exited.', { code, signal });
      }
      postToRenderer(session, { reason: code === 2 ? 'unsupported' : 'exited', type: 'end' });
    }
    finishSession(session, code === 2 ? 'unsupported' : 'exited', code, signal);
  });
}

function startSession(options, port) {
  stopSession(activeSession, { closePort: true });

  if (!port || !options?.helperPath || !options?.sourceId
    || options.protocolVersion !== NATIVE_CAPTURE_PROTOCOL_VERSION) {
    postParent({ reason: 'bad-start', type: 'exited' });
    return;
  }

  const fps = Number.isInteger(options.fps) && options.fps > 0 && options.fps <= 60 ? options.fps : 30;
  const maxHeight = Number.isInteger(options.maxHeight) && options.maxHeight > 0 && options.maxHeight <= 16384
    ? options.maxHeight
    : 1080;
  const session = {
    child: null,
    forceKillTimer: null,
    fps,
    frameState: createFrameState(),
    framesParsed: 0,
    framesPosted: 0,
    helperPath: options.helperPath,
    maxHeight,
    port,
    restartPolicy: createRestartPolicy(),
    restarts: 0,
    sourceId: options.sourceId,
    statsTimer: null,
    stopped: false
  };
  activeSession = session;

  port.on?.('message', (event) => {
    if (event.data?.type === 'stop') stopSession(session, { closePort: true });
  });
  port.on?.('close', () => stopSession(session, { closePort: false }));
  port.start?.();

  let child = null;
  try {
    child = spawnHelper(session);
  } catch (error) {
    log('error', 'Native capture helper process error.', { message: String(error?.message || error) });
    postToRenderer(session, { reason: 'spawn-error', type: 'end' });
    finishSession(session, 'spawn-error');
    return;
  }

  attachChild(session, child);
  startStatsTimer(session);
}

function stopSession(session, options = {}) {
  if (!session || session.stopped) return false;
  session.stopped = true;
  stopStatsTimer(session);

  if (options.closePort) {
    try {
      session.port?.close?.();
    } catch {
      // Port may already be closed from the renderer side.
    }
  }

  const child = session.child;
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    session.forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 2000);
    session.forceKillTimer.unref?.();
  } else {
    finishSession(session, 'stopped');
  }
  return true;
}

function finishSession(session, reason, code = 0, signal = null) {
  if (!session || activeSession !== session) return;
  if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
  stopStatsTimer(session);
  activeSession = null;
  postParent({ code, reason, signal, type: 'exited' });
  setImmediate(() => process.exit(0));
}

if (!parentPort) {
  process.exit(1);
}

parentPort.on('message', (event) => {
  const message = event.data || event;
  if (message?.type === 'start') {
    startSession(message, event.ports?.[0]);
  } else if (message?.type === 'stop') {
    stopSession(activeSession, { closePort: true });
  } else if (message?.type === 'reconfigure') {
    handleReconfigure(activeSession, message);
  }
});
parentPort.start?.();

process.on('disconnect', () => stopSession(activeSession, { closePort: true }));
process.on('exit', () => stopSession(activeSession, { closePort: true }));