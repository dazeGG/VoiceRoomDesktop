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
  selectSource: (sourceId, audioOptions) => ipcRenderer.invoke('desktop-capture:select-source', sourceId, audioOptions)
});

contextBridge.exposeInMainWorld('voiceRoomDesktopAudio', {
  getCapabilities: () => ipcRenderer.invoke('desktop-audio:get-capabilities'),
  openSettings: () => ipcRenderer.invoke('desktop-audio:open-settings'),
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

contextBridge.exposeInMainWorld('voiceRoomWindow', {
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  setFullscreen: (fullscreen) => ipcRenderer.invoke('window:set-fullscreen', fullscreen)
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.electron = 'true';
});
