'use strict';

const { app, MessageChannelMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const log = require('./logger');

// Binary frame protocol shared with native/capture/windows/ScreenCursorCapture.cpp:
// 24-byte header (u32 magic 'VRF1', u32 width, u32 height, u32 flags,
// i64 timestampMs) followed by width * height * 4 bytes of top-down BGRA.
const FRAME_MAGIC = 0x31465256;
const FRAME_HEADER_BYTES = 24;
const MAX_FRAME_DIMENSION = 16384;
const PORT_CHANNEL = 'native-capture:port';

let activeSession = null;
let nextSessionId = 1;

app.on('before-quit', () => {
  stopNativeCaptureSession();
});

function isNativeCaptureEnabled() {
  return process.env.VOICE_ROOM_NATIVE_CAPTURE !== '0';
}

function getNativeCaptureCapabilities() {
  const helperLookup = findScreenCursorCaptureHelper();
  return {
    available: process.platform === 'win32' && isNativeCaptureEnabled() && Boolean(helperLookup.path),
    platform: process.platform,
    reason: process.platform !== 'win32'
      ? 'platform-unsupported'
      : !isNativeCaptureEnabled()
        ? 'disabled-by-env'
        : helperLookup.path ? '' : helperLookup.reason
  };
}

function findScreenCursorCaptureHelper() {
  if (process.platform !== 'win32') {
    return { path: '', reason: 'platform-unsupported' };
  }

  const executable = 'ScreenCursorCapture.exe';
  const appPath = app.getAppPath();
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'native', 'bin', 'windows', executable),
    path.join(process.resourcesPath || '', 'native', 'bin', 'windows', executable),
    path.join(appPath, 'native', 'bin', 'windows', executable)
  ];

  const match = candidates.find((candidate) => !candidate.includes('.asar' + path.sep) && fs.existsSync(candidate));
  return {
    path: match || '',
    reason: match ? '' : 'helper-missing'
  };
}

// Spawns the capture helper for a desktop source granted to `webContents` and
// hands the renderer a MessagePort that delivers format/frame/end messages.
function startNativeCaptureSession(webContents, options = {}) {
  const capabilities = getNativeCaptureCapabilities();
  if (!capabilities.available) {
    return { ok: false, reason: capabilities.reason || 'unavailable' };
  }

  const sourceId = String(options.sourceId || '');
  if (!/^(screen|window):\d+/.test(sourceId)) {
    return { ok: false, reason: 'bad-source' };
  }

  stopNativeCaptureSession();

  const helperPath = findScreenCursorCaptureHelper().path;
  const fps = Number.isInteger(options.fps) && options.fps > 0 && options.fps <= 60 ? options.fps : 30;
  const sessionId = String(nextSessionId++);
  const child = spawn(helperPath, ['--source', sourceId, '--fps', String(fps)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const { port1, port2 } = new MessageChannelMain();
  const session = {
    child,
    chunks: [],
    chunkBytes: 0,
    expectedFrame: null,
    id: sessionId,
    port: port1,
    stopped: false,
    webContents,
    webContentsDestroyedListener: null
  };
  activeSession = session;

  session.webContentsDestroyedListener = () => stopNativeCaptureSession(sessionId);
  webContents.once('destroyed', session.webContentsDestroyedListener);

  port1.on('message', (event) => {
    if (event.data?.type === 'stop') stopNativeCaptureSession(sessionId);
  });
  port1.on('close', () => stopNativeCaptureSession(sessionId));
  port1.start();

  child.stdout.on('data', (chunk) => {
    if (activeSession !== session || session.stopped) return;
    session.chunks.push(chunk);
    session.chunkBytes += chunk.length;
    drainFrames(session);
  });

  child.stderr.on('data', (chunk) => {
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
        log.warn('Native capture helper error:', event.message || '');
      } else if (event.event !== 'exit') {
        log.info('Native capture helper:', event.message || event.event);
      }
    }
  });

  child.on('error', (error) => {
    log.error('Native capture helper process error:', error);
    endSession(session, 'spawn-error');
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      log.warn('Native capture helper exited:', { code, sessionId, signal });
    }
    endSession(session, code === 2 ? 'unsupported' : 'exited');
  });

  webContents.postMessage(PORT_CHANNEL, { sessionId }, [port2]);
  return { fps, ok: true, sessionId };
}

function drainFrames(session) {
  for (;;) {
    if (!session.expectedFrame) {
      if (session.chunkBytes < FRAME_HEADER_BYTES) return;
      const header = takeBytes(session, FRAME_HEADER_BYTES);
      const magic = header.readUInt32LE(0);
      const width = header.readUInt32LE(4);
      const height = header.readUInt32LE(8);
      const flags = header.readUInt32LE(12);
      const timestampMs = Number(header.readBigInt64LE(16));

      if (magic !== FRAME_MAGIC || !width || !height
        || width > MAX_FRAME_DIMENSION || height > MAX_FRAME_DIMENSION) {
        log.error('Native capture stream is corrupted, stopping session.');
        stopNativeCaptureSession(session.id);
        return;
      }
      session.expectedFrame = {
        flags,
        height,
        payloadBytes: width * height * 4,
        timestampMs,
        width
      };
    }

    if (session.chunkBytes < session.expectedFrame.payloadBytes) return;
    const frame = session.expectedFrame;
    session.expectedFrame = null;
    const payload = takeBytes(session, frame.payloadBytes);
    postToRenderer(session, {
      data: toFrameArrayBuffer(payload),
      flags: frame.flags,
      height: frame.height,
      timestampMs: frame.timestampMs,
      type: 'frame',
      width: frame.width
    });
  }
}

// Consumes exactly `length` bytes from the buffered stdout chunks with a
// single copy for multi-chunk reads (frames span ~128 pipe chunks; repeated
// Buffer.concat per chunk would be quadratic).
function takeBytes(session, length) {
  session.chunkBytes -= length;

  const first = session.chunks[0];
  if (first.length === length) {
    session.chunks.shift();
    return first;
  }
  if (first.length > length) {
    session.chunks[0] = first.subarray(length);
    return first.subarray(0, length);
  }

  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const chunk = session.chunks[0];
    const needed = length - offset;
    if (chunk.length <= needed) {
      chunk.copy(result, offset);
      offset += chunk.length;
      session.chunks.shift();
    } else {
      chunk.copy(result, offset, 0, needed);
      session.chunks[0] = chunk.subarray(needed);
      offset += needed;
    }
  }
  return result;
}

function toFrameArrayBuffer(buffer) {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer;
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function postToRenderer(session, message) {
  if (session.stopped) return;
  try {
    session.port.postMessage(message);
  } catch (error) {
    log.warn('Native capture port post failed:', error);
    stopNativeCaptureSession(session.id);
  }
}

function endSession(session, reason) {
  if (session.stopped) return;
  postToRenderer(session, { reason, type: 'end' });
  stopNativeCaptureSession(session.id);
}

function stopNativeCaptureSession(sessionId = '') {
  const session = activeSession;
  if (!session) return false;
  if (sessionId && session.id !== sessionId) return false;

  activeSession = null;
  session.stopped = true;
  session.chunks = [];
  session.chunkBytes = 0;

  if (session.webContentsDestroyedListener && !session.webContents.isDestroyed()) {
    session.webContents.removeListener('destroyed', session.webContentsDestroyedListener);
  }
  try {
    session.port.close();
  } catch {
    // Port may already be closed from the renderer side.
  }

  const child = session.child;
  if (child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 2000);
    forceKillTimer.unref?.();
  }
  return true;
}

module.exports = {
  getNativeCaptureCapabilities,
  startNativeCaptureSession,
  stopNativeCaptureSession
};
