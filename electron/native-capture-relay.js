'use strict';

const { spawn } = require('node:child_process');

const {
  appendFrameChunk,
  createFrameState
} = require('./native-capture-frames');

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
    session.port.postMessage(message);
    return true;
  } catch (error) {
    log('warn', 'Native capture relay port post failed.', { message: String(error?.message || error) });
    stopSession(session, { closePort: true });
    return false;
  }
}

function startSession(options, port) {
  stopSession(activeSession, { closePort: true });

  if (!port || !options?.helperPath || !options?.sourceId) {
    postParent({ reason: 'bad-start', type: 'exited' });
    return;
  }

  const fps = Number.isInteger(options.fps) && options.fps > 0 && options.fps <= 60 ? options.fps : 30;
  const session = {
    child: null,
    forceKillTimer: null,
    fps,
    frameState: createFrameState(),
    port,
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
    child = spawn(options.helperPath, ['--source', String(options.sourceId), '--fps', String(fps)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    log('error', 'Native capture helper process error.', { message: String(error?.message || error) });
    postToRenderer(session, { reason: 'spawn-error', type: 'end' });
    finishSession(session, 'spawn-error');
    return;
  }

  session.child = child;

  child.stdout.on('data', (chunk) => {
    if (activeSession !== session || session.stopped) return;
    const result = appendFrameChunk(session.frameState, chunk);
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
          fps: Number(event.fps) || fps,
          height: Number(event.height) || 0,
          type: 'format',
          width: Number(event.width) || 0
        });
      } else if (event.event === 'error') {
        log('warn', 'Native capture helper error.', event.message || '');
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
    if (!session.stopped) {
      if (code !== 0 && code !== null) {
        log('warn', 'Native capture helper exited.', { code, signal });
      }
      postToRenderer(session, { reason: code === 2 ? 'unsupported' : 'exited', type: 'end' });
    }
    finishSession(session, code === 2 ? 'unsupported' : 'exited', code, signal);
  });
}

function stopSession(session, options = {}) {
  if (!session || session.stopped) return false;
  session.stopped = true;

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
  }
});
parentPort.start?.();

process.on('disconnect', () => stopSession(activeSession, { closePort: true }));
process.on('exit', () => stopSession(activeSession, { closePort: true }));
