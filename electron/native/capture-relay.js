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

const MAX_RENDERER_FRAMES_IN_FLIGHT = 2;
const RECONFIGURE_ACK_TIMEOUT_MS = 2000;
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
  const isFrame = message.type === 'frame';
  if (isFrame && session.framesInFlight >= MAX_RENDERER_FRAMES_IN_FLIGHT) {
    // Keep the cross-process MessagePort queue bounded. The renderer acks as
    // soon as the generator accepts a frame (or becomes writable after a drop);
    // until then, retaining more raw frame buffers only adds latency and memory
    // pressure without helping the encoder.
    session.framesDroppedBackpressure += 1;
    setHelperPaused(session, true);
    return true;
  }

  try {
    // Electron MessagePortMain transfer lists accept MessagePortMain objects,
    // not ArrayBuffers. Passing the frame buffer as a transferable throws and
    // tears down the native session, so raw payloads must use structured clone
    // until the bridge has a supported shared/encoded transport.
    if (isFrame) session.framesInFlight += 1;
    session.port.postMessage(message);
    if (isFrame) {
      session.framesPosted += 1;
      if (session.framesInFlight >= MAX_RENDERER_FRAMES_IN_FLIGHT) {
        setHelperPaused(session, true);
      }
    }
    return true;
  } catch (error) {
    if (isFrame && session.framesInFlight > 0) session.framesInFlight -= 1;
    log('warn', 'Native capture relay port post failed.', { message: String(error?.message || error) });
    stopSession(session, { closePort: true });
    return false;
  }
}

function writeChildCommand(session, payload) {
  const child = session?.child;
  if (!child?.stdin?.writable) return false;

  try {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    return false;
  }
}

function setHelperPaused(session, paused) {
  if (!session || session.stopped || session.helperPaused === paused) return true;
  if (!writeChildCommand(session, { cmd: 'set-paused', paused })) return false;
  session.helperPaused = paused;
  return true;
}

function handleRendererMessage(session, event) {
  if (event.data?.type === 'frame-ack') {
    if (session.framesInFlight > 0) session.framesInFlight -= 1;
    if (session.framesInFlight < MAX_RENDERER_FRAMES_IN_FLIGHT) {
      setHelperPaused(session, false);
    }
  } else if (event.data?.type === 'stop') {
    stopSession(session, { closePort: true });
  }
}

function spawnHelper(session) {
  return spawn(session.helperPath, [
    '--source',
    String(session.sourceId),
    '--fps',
    String(session.fps),
    '--max-height',
    String(session.maxHeight),
    '--max-width',
    String(session.maxWidth)
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function writeReconfigureToChild(session, command) {
  const payload = buildReconfigureStdinPayload(session, command);
  const requestId = Number.isInteger(command.requestId) && command.requestId > 0
    ? command.requestId
    : null;
  if (requestId !== null) payload.requestId = requestId;
  if (!writeChildCommand(session, payload)) return false;

  if (requestId !== null) {
    const timer = setTimeout(() => {
      const pending = session.pendingReconfigures.get(requestId);
      if (!pending) return;
      session.pendingReconfigures.delete(requestId);
      postParent({ ok: false, reason: 'helper-ack-timeout', requestId, type: 'reconfigured' });
    }, RECONFIGURE_ACK_TIMEOUT_MS);
    timer.unref?.();
    session.pendingReconfigures.set(requestId, { payload, timer });
  }
  return true;
}

function handleReconfigure(session, message) {
  const command = normalizeReconfigureCommand(message);
  if (!command || !session?.child) return false;
  if (Number.isInteger(message.requestId) && message.requestId > 0) {
    command.requestId = message.requestId;
  }
  return writeReconfigureToChild(session, command);
}

function finishPendingReconfigure(session, event) {
  const requestId = Number(event.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) return null;
  const pending = session.pendingReconfigures.get(requestId);
  if (!pending) return null;

  clearTimeout(pending.timer);
  session.pendingReconfigures.delete(requestId);
  const applied = {
    fps: Number(event.fps) || pending.payload.fps,
    maxHeight: Number(event.maxHeight) || pending.payload.maxHeight,
    maxWidth: Number(event.maxWidth) || pending.payload.maxWidth
  };
  session.fps = applied.fps;
  session.maxHeight = applied.maxHeight;
  session.maxWidth = applied.maxWidth;
  const result = { ...applied, ok: true, requestId, type: 'reconfigured' };
  postParent(result);
  return result;
}

function failPendingReconfigures(session, reason) {
  if (!session?.pendingReconfigures) return [];
  const results = [];
  for (const [requestId, pending] of session.pendingReconfigures.entries()) {
    clearTimeout(pending.timer);
    const result = { ok: false, reason, requestId, type: 'reconfigured' };
    results.push(result);
    postParent(result);
  }
  session.pendingReconfigures.clear();
  return results;
}

function parseHelperStderrChunk(state, chunk, options = {}) {
  state.buffer = `${state.buffer || ''}${chunk == null ? '' : String(chunk)}`;
  const lines = state.buffer.split(/\r?\n/);
  if (options.flush) {
    state.buffer = '';
  } else {
    state.buffer = lines.pop() || '';
  }

  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ event: 'log', message: line });
    }
  }
  return events;
}

function handleHelperEvent(session, event) {
  if (event.event === 'format') {
    postToRenderer(session, {
      fps: Number(event.fps) || session.fps,
      height: Number(event.height) || 0,
      pixelFormat: event.pixelFormat || '',
      type: 'format',
      width: Number(event.width) || 0
    });
  } else if (event.event === 'reconfigured') {
    return finishPendingReconfigure(session, event);
  } else if (event.event === 'error') {
    log('warn', 'Native capture helper error.', event.message || '');
  } else if (event.event === 'warning') {
    log('warn', 'Native capture helper warning.', event.message || '');
  } else if (event.event !== 'exit') {
    log('info', 'Native capture helper.', event.message || event.event);
  }
  return null;
}

function handleChildStdinError(session, child) {
  if (!session || session.stopped || session.child !== child) return false;
  failPendingReconfigures(session, 'helper-stdin-error');
  return true;
}

function startStatsTimer(session) {
  stopStatsTimer(session);
  session.statsTimer = setInterval(() => {
    if (activeSession !== session || session.stopped) return;
    postToRenderer(session, {
      framesParsed: session.framesParsed,
      framesDroppedBackpressure: session.framesDroppedBackpressure,
      framesInFlight: session.framesInFlight,
      framesPosted: session.framesPosted,
      helperPaused: session.helperPaused,
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
  session.helperPaused = false;
  const stderrState = { buffer: '' };

  // A reconfigure write racing the child's death surfaces EPIPE as an async
  // 'error' event on the stdin stream (not a throw writeReconfigureToChild can
  // catch). Without this listener that event would crash the utility process
  // and take the whole capture relay down. The exit handler owns recovery.
  child.stdin.on('error', () => handleChildStdinError(session, child));

  child.stdout.on('data', (chunk) => {
    if (activeSession !== session || session.stopped || session.child !== child) return;
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
    if (activeSession !== session || session.stopped || session.child !== child) return;
    for (const event of parseHelperStderrChunk(stderrState, chunk)) {
      handleHelperEvent(session, event);
    }
  });

  child.on('error', (error) => {
    if (activeSession !== session || session.child !== child) return;
    failPendingReconfigures(session, 'helper-process-error');
    log('error', 'Native capture helper process error.', { message: String(error?.message || error) });
    postToRenderer(session, { reason: 'spawn-error', type: 'end' });
    finishSession(session, 'spawn-error');
  });

  child.on('exit', (code, signal) => {
    if (activeSession !== session || session.child !== child) return;
    if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
    for (const event of parseHelperStderrChunk(stderrState, null, { flush: true })) {
      handleHelperEvent(session, event);
    }
    failPendingReconfigures(session, 'helper-exited');

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
        if (session.framesInFlight >= MAX_RENDERER_FRAMES_IN_FLIGHT) {
          setHelperPaused(session, true);
        }
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
  const maxHeight = Number.isInteger(options.maxHeight) && options.maxHeight >= 2 && options.maxHeight <= 16384
    ? options.maxHeight
    : 1080;
  const maxWidth = Number.isInteger(options.maxWidth) && options.maxWidth >= 2 && options.maxWidth <= 16384
    ? options.maxWidth
    : 1920;
  const session = {
    child: null,
    forceKillTimer: null,
    fps,
    frameState: createFrameState(),
    framesDroppedBackpressure: 0,
    framesInFlight: 0,
    framesParsed: 0,
    framesPosted: 0,
    helperPaused: false,
    helperPath: options.helperPath,
    maxHeight,
    maxWidth,
    port,
    pendingReconfigures: new Map(),
    restartPolicy: createRestartPolicy(),
    restarts: 0,
    sourceId: options.sourceId,
    statsTimer: null,
    stopped: false
  };
  activeSession = session;

  port.on?.('message', (event) => handleRendererMessage(session, event));
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
  failPendingReconfigures(session, 'session-stopped');

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
  failPendingReconfigures(session, reason || 'session-finished');
  activeSession = null;
  postParent({ code, reason, signal, type: 'exited' });
  setImmediate(() => process.exit(0));
}

if (!parentPort) {
  if (require.main === module) process.exit(1);
} else {
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
}

module.exports = {
  failPendingReconfigures,
  finishPendingReconfigure,
  handleChildStdinError,
  handleHelperEvent,
  handleReconfigure,
  handleRendererMessage,
  parseHelperStderrChunk,
  postToRenderer
};
