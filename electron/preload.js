'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceRoomRuntime', {
  isDesktop: true,
  isElectron: true,
  platform: process.platform
});

contextBridge.exposeInMainWorld('voiceRoomDesktopCapture', {
  getSources: () => ipcRenderer.invoke('desktop-capture:get-sources'),
  openPicker: (options) => ipcRenderer.invoke('desktop-capture:open-picker', options),
  selectSource: (sourceId, audioOptions, captureOptions) => ipcRenderer.invoke(
    'desktop-capture:select-source',
    sourceId,
    audioOptions,
    captureOptions
  )
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
  start: () => ipcRenderer.invoke('native-capture:start'),
  stop: (sessionId) => ipcRenderer.invoke('native-capture:stop', sessionId)
});

// The frame MessagePort cannot cross the context bridge; relay it to the main
// world (shared DOM) where the injected getDisplayMedia wrapper picks it up.
ipcRenderer.on('native-capture:port', (event, message) => {
  window.postMessage(
    { sessionId: message?.sessionId, type: 'voice-room-native-capture-port' },
    window.location.origin,
    event.ports
  );
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
  document.documentElement.dataset.electron = 'true';
  void warmUpMediaDeviceAccess();
});
