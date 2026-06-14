'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceRoomUpdateGate', {
  onState: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('update-gate:state', listener);
    return () => ipcRenderer.removeListener('update-gate:state', listener);
  },
  proceed: () => ipcRenderer.invoke('update-gate:proceed'),
  quit: () => ipcRenderer.invoke('update-gate:quit')
});