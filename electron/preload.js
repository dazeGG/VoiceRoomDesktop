'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// Keep these constants inline: preload must always install desktop runtime
// markers even if optional native-capture module packaging drifts.
const NATIVE_CAPTURE_PROTOCOL_VERSION = 2;
const NATIVE_CAPTURE_PORT_MESSAGE_TYPE = 'voice-room-native-capture-port';
const NATIVE_CAPTURE_PORT_BUFFER_LIMIT = 4;
const NATIVE_CAPTURE_PORT_TTL_MS = 5000;
const NATIVE_CAPTURE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pendingNativeCapturePorts = new Map();
const requestedNativeCapturePorts = new Map();

const DESKTOP_VERSION_ARG = '--voice-room-desktop-version=';

function getDesktopVersion() {
  const arg = process.argv.find((value) => value.startsWith(DESKTOP_VERSION_ARG));
  return arg ? arg.slice(DESKTOP_VERSION_ARG.length) : '';
}

function markDesktopDocument() {
  const root = document.documentElement;
  if (!root) return;
  root.classList.add('is-desktop');
  root.dataset.electron = 'true';
}

function isNativeCaptureSessionId(value) {
  return typeof value === 'string' && NATIVE_CAPTURE_SESSION_ID_PATTERN.test(value);
}

function closePort(port) {
  try { port?.close(); } catch {}
}

function removePortEntry(entries, sessionId, close = false) {
  const entry = entries.get(sessionId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  entries.delete(sessionId);
  if (close) closePort(entry.port);
  return entry;
}

function evictOldestPortEntry(entries, close = false) {
  const oldestSessionId = entries.keys().next().value;
  if (oldestSessionId !== undefined) removePortEntry(entries, oldestSessionId, close);
}

function forwardNativeCapturePort(message, port) {
  try {
    window.postMessage(
      {
        protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
        sessionId: message.sessionId,
        type: NATIVE_CAPTURE_PORT_MESSAGE_TYPE
      },
      window.location.origin,
      [port]
    );
    return true;
  } catch {
    closePort(port);
    return false;
  }
}

function requestNativeCapturePort(sessionId) {
  if (!isNativeCaptureSessionId(sessionId)) return false;

  const pending = removePortEntry(pendingNativeCapturePorts, sessionId);
  if (pending) return forwardNativeCapturePort(pending.message, pending.port);
  if (requestedNativeCapturePorts.has(sessionId)) return true;

  if (requestedNativeCapturePorts.size >= NATIVE_CAPTURE_PORT_BUFFER_LIMIT) {
    evictOldestPortEntry(requestedNativeCapturePorts);
  }
  const timer = setTimeout(() => {
    const requested = requestedNativeCapturePorts.get(sessionId);
    if (requested?.timer === timer) requestedNativeCapturePorts.delete(sessionId);
  }, NATIVE_CAPTURE_PORT_TTL_MS);
  requestedNativeCapturePorts.set(sessionId, { timer });
  return true;
}

const desktopRuntime = {
  isDesktop: true,
  isElectron: true,
  platform: process.platform,
  version: getDesktopVersion()
};

markDesktopDocument();

contextBridge.exposeInMainWorld('voiceRoomRuntime', desktopRuntime);

contextBridge.exposeInMainWorld('voiceRoomDesktop', desktopRuntime);

contextBridge.exposeInMainWorld('voiceRoomDesktopCapture', {
  applyProfile: (options) => ipcRenderer.invoke('desktop-capture:apply-profile', options),
  getSources: () => ipcRenderer.invoke('desktop-capture:get-sources'),
  openPicker: (options) => ipcRenderer.invoke('desktop-capture:open-picker', options),
  selectSource: (sourceId, audioOptions, captureOptions) => ipcRenderer.invoke(
    'desktop-capture:select-source',
    sourceId,
    audioOptions,
    captureOptions
  )
});

contextBridge.exposeInMainWorld('voiceRoomDesktopNotifications', {
  show: (payload) => ipcRenderer.invoke('desktop-notifications:show', payload)
});

contextBridge.exposeInMainWorld('voiceRoomDesktopIdle', {
  getSystemIdleTime: () => ipcRenderer.invoke('desktop-idle:get-system-idle-time')
});

contextBridge.exposeInMainWorld('voiceRoomDesktopHotkeys', {
  configure: (payload) => ipcRenderer.invoke('desktop-hotkeys:configure', payload),
  onAction: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop-hotkeys:action', listener);
    return () => ipcRenderer.removeListener('desktop-hotkeys:action', listener);
  },
  onStatus: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop-hotkeys:status', listener);
    return () => ipcRenderer.removeListener('desktop-hotkeys:status', listener);
  },
  setSuspended: (suspended) => ipcRenderer.invoke('desktop-hotkeys:set-suspended', Boolean(suspended))
});

contextBridge.exposeInMainWorld('voiceRoomDesktopAudio', {
  ensureMediaAccess: () => ipcRenderer.invoke('desktop-audio:ensure-media-access'),
  getCapabilities: () => ipcRenderer.invoke('desktop-audio:get-capabilities'),
  openSettings: (options) => ipcRenderer.invoke('desktop-audio:open-settings', options),
  onData: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop-audio:data', listener);
    return () => ipcRenderer.removeListener('desktop-audio:data', listener);
  },
  onEvent: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop-audio:event', listener);
    return () => ipcRenderer.removeListener('desktop-audio:event', listener);
  },
  startSafeSystem: (options) => ipcRenderer.invoke('desktop-audio:start-safe-system', options),
  stop: (sessionId) => ipcRenderer.invoke('desktop-audio:stop', sessionId)
});

contextBridge.exposeInMainWorld('voiceRoomNativeCaptureBridge', {
  commitPrepared: (sourceId) => ipcRenderer.invoke('native-capture:commit-prepared', sourceId),
  prepare: () => ipcRenderer.invoke('native-capture:prepare'),
  requestPort: (sessionId) => requestNativeCapturePort(sessionId),
  start: () => ipcRenderer.invoke('native-capture:start'),
  stop: (sessionId) => ipcRenderer.invoke('native-capture:stop', sessionId)
});

// MessagePorts cannot cross contextBridge. Buffer a small, short-lived set in
// the isolated preload until the main-world wrapper installs its listener and
// requests the unguessable session id returned by prepare()/start().
ipcRenderer.on('native-capture:port', (event, message) => {
  const ports = Array.from(event.ports || []);
  const port = ports.shift();
  for (const extraPort of ports) closePort(extraPort);

  const sessionId = message?.sessionId;
  if (
    message?.protocolVersion !== NATIVE_CAPTURE_PROTOCOL_VERSION
    || !isNativeCaptureSessionId(sessionId)
    || !port
  ) {
    closePort(port);
    return;
  }

  const requested = removePortEntry(requestedNativeCapturePorts, sessionId);
  if (requested) {
    forwardNativeCapturePort(message, port);
    return;
  }

  removePortEntry(pendingNativeCapturePorts, sessionId, true);
  if (pendingNativeCapturePorts.size >= NATIVE_CAPTURE_PORT_BUFFER_LIMIT) {
    evictOldestPortEntry(pendingNativeCapturePorts, true);
  }
  const timer = setTimeout(() => {
    const pending = pendingNativeCapturePorts.get(sessionId);
    if (pending?.timer !== timer || pending.port !== port) return;
    pendingNativeCapturePorts.delete(sessionId);
    closePort(port);
  }, NATIVE_CAPTURE_PORT_TTL_MS);
  pendingNativeCapturePorts.set(sessionId, { message, port, timer });
});

contextBridge.exposeInMainWorld('voiceRoomWindow', {
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  setFullscreen: (fullscreen) => ipcRenderer.invoke('window:set-fullscreen', fullscreen)
});

contextBridge.exposeInMainWorld('voiceRoomRecovery', {
  reload: () => ipcRenderer.invoke('window:reload-main')
});

async function warmUpMediaDeviceAccess() {
  try {
    await ipcRenderer.invoke('desktop-audio:ensure-media-access');
  } catch {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
  } catch {
    // Web app can retry and surface its own permission UI.
  }
}

window.addEventListener('DOMContentLoaded', () => {
  markDesktopDocument();
  void warmUpMediaDeviceAccess();
});
