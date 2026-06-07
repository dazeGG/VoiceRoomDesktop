'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceRoomRuntime', {
  isDesktop: true,
  isElectron: true,
  platform: process.platform
});

contextBridge.exposeInMainWorld('voiceRoomDesktopCapture', {
  getSources: () => ipcRenderer.invoke('desktop-capture:get-sources'),
  selectSource: (sourceId, audioMode) => ipcRenderer.invoke('desktop-capture:select-source', sourceId, audioMode)
});

contextBridge.exposeInMainWorld('voiceRoomWindow', {
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  setFullscreen: (fullscreen) => ipcRenderer.invoke('window:set-fullscreen', fullscreen)
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.electron = 'true';
});
