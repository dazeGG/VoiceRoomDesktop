'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceRoomOverlay', {
  action: (name) => ipcRenderer.invoke('desktop-overlay:action', name),
  onState: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop-overlay:state', listener);
    return () => ipcRenderer.removeListener('desktop-overlay:state', listener);
  },
  ready: () => ipcRenderer.invoke('desktop-overlay:ready'),
  reportSize: (size) => ipcRenderer.invoke('desktop-overlay:content-size', size)
});
