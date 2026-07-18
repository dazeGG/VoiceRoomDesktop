'use strict';

const { app, MessageChannelMain, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const log = require('../logger');
const { NATIVE_CAPTURE_PROTOCOL_VERSION } = require('./capture-contract');

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
  const maxHeight = Number.isInteger(options.maxHeight) && options.maxHeight > 0 && options.maxHeight <= 16384
    ? options.maxHeight
    : 1080;
  const maxWidth = Number.isInteger(options.maxWidth) && options.maxWidth > 0 && options.maxWidth <= 16384
    ? options.maxWidth
    : 1920;
  const qualityId = String(options.qualityId || 'balanced');
  const sessionId = String(nextSessionId++);
  const { port1, port2 } = new MessageChannelMain();
  let relay = null;
  try {
    relay = utilityProcess.fork(path.join(__dirname, 'capture-relay.js'), [], {
      serviceName: 'Voice Room Native Capture Relay',
      stdio: 'ignore'
    });
  } catch (error) {
    log.error('Native capture relay failed to start:', error);
    try {
      port1.close();
      port2.close();
    } catch {}
    return { ok: false, reason: 'spawn-error' };
  }

  const session = {
    forceKillTimer: null,
    id: sessionId,
    relay,
    stopped: false,
    webContents,
    webContentsDestroyedListener: null
  };
  activeSession = session;

  session.webContentsDestroyedListener = () => stopNativeCaptureSession(sessionId);
  webContents.once('destroyed', session.webContentsDestroyedListener);

  relay.on('message', (message) => {
    if (activeSession !== session && !session.stopped) return;
    if (session.stopped && message?.type !== 'exited') return;
    if (message?.type === 'log') {
      const detail = message.detail;
      if (message.level === 'error') {
        log.error(message.message, detail || '');
      } else if (message.level === 'warn') {
        log.warn(message.message, detail || '');
      } else {
        log.info(message.message, detail || '');
      }
    } else if (message?.type === 'exited') {
      if (message.reason !== 'stopped' && message.code !== 0 && message.code !== null) {
        log.warn('Native capture relay exited:', {
          code: message.code,
          reason: message.reason,
          sessionId,
          signal: message.signal
        });
      }
      cleanupSession(session);
    }
  });

  relay.on('error', (error) => {
    if (activeSession === session && !session.stopped) {
      log.error('Native capture relay error:', error);
    }
    cleanupSession(session);
  });

  relay.on('exit', (code) => {
    if (activeSession === session && !session.stopped && code !== 0 && code !== null) {
      log.warn('Native capture relay process exited:', { code, sessionId });
    }
    cleanupSession(session);
  });

  try {
    relay.postMessage({
      fps,
      helperPath,
      maxHeight,
      maxWidth,
      protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
      qualityId,
      sourceId,
      type: 'start'
    }, [port1]);
    // Return the IPC session descriptor before the DOM MessagePort is delivered.
    // The injected getDisplayMedia wrapper installs its waitForPort listener
    // after the invoke() promise resolves; posting on the next tick avoids a
    // rare lost-port race while keeping the existing one-call bridge contract.
    setImmediate(() => {
      if (activeSession !== session || session.stopped) {
        try {
          port2.close();
        } catch {}
        return;
      }
      try {
        webContents.postMessage(PORT_CHANNEL, {
          protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
          sessionId
        }, [port2]);
      } catch (error) {
        log.error('Native capture port delivery failed:', error);
        stopNativeCaptureSession(sessionId);
      }
    });
  } catch (error) {
    log.error('Native capture relay setup failed:', error);
    stopNativeCaptureSession(sessionId);
    return { ok: false, reason: 'spawn-error' };
  }

  return {
    fps,
    maxHeight,
    maxWidth,
    ok: true,
    protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
    qualityId,
    sessionId,
    sourceId
  };
}

function stopNativeCaptureSession(sessionId = '') {
  const session = activeSession;
  if (!session) return false;
  if (sessionId && session.id !== sessionId) return false;

  activeSession = null;
  session.stopped = true;

  if (session.webContentsDestroyedListener && !session.webContents.isDestroyed()) {
    session.webContents.removeListener('destroyed', session.webContentsDestroyedListener);
  }
  try {
    session.relay.postMessage({ type: 'stop' });
  } catch {
    // Relay may already be gone.
  }

  session.forceKillTimer = setTimeout(() => {
    try {
      if (session.relay.pid) session.relay.kill();
    } catch {
      // The relay may have exited between the timer check and kill.
    }
  }, 2000);
  session.forceKillTimer.unref?.();
  return true;
}

function cleanupSession(session) {
  if (activeSession === session) activeSession = null;
  session.stopped = true;
  if (session.forceKillTimer) {
    clearTimeout(session.forceKillTimer);
    session.forceKillTimer = null;
  }
  if (session.webContentsDestroyedListener && !session.webContents.isDestroyed()) {
    session.webContents.removeListener('destroyed', session.webContentsDestroyedListener);
  }
}

function reconfigureNativeCaptureSession({ fps, maxHeight, maxWidth } = {}) {
  const session = activeSession;
  if (!session || session.stopped) {
    return { ok: false, reason: 'no-active-session' };
  }

  const payload = { type: 'reconfigure' };
  if (Number.isInteger(fps) && fps > 0 && fps <= 60) payload.fps = fps;
  if (Number.isInteger(maxHeight) && maxHeight > 0 && maxHeight <= 16384) payload.maxHeight = maxHeight;
  if (Number.isInteger(maxWidth) && maxWidth > 0 && maxWidth <= 16384) payload.maxWidth = maxWidth;
  if (!payload.fps && !payload.maxHeight && !payload.maxWidth) {
    return { ok: false, reason: 'bad-profile' };
  }

  try {
    session.relay.postMessage(payload);
  } catch {
    return { ok: false, reason: 'relay-unavailable' };
  }

  return {
    fps: payload.fps,
    maxHeight: payload.maxHeight,
    maxWidth: payload.maxWidth,
    ok: true
  };
}

module.exports = {
  getNativeCaptureCapabilities,
  reconfigureNativeCaptureSession,
  startNativeCaptureSession,
  stopNativeCaptureSession
};
