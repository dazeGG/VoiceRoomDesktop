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
contextBridge.exposeInMainWorld('voiceRoomLocale', {
  get: () => ipcRenderer.invoke('locale:get'),
  set: (locale) => ipcRenderer.invoke('locale:set', locale),
  subscribe: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, locale) => {
      if (locale === 'ru' || locale === 'en' || locale === 'fr') handler(locale);
    };
    ipcRenderer.on('locale:changed', listener);
    return () => ipcRenderer.removeListener('locale:changed', listener);
  }
});
