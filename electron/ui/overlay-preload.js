'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceRoomOverlay', {
  onState: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop-overlay:state', listener);
    return () => ipcRenderer.removeListener('desktop-overlay:state', listener);
  },
  ready: () => ipcRenderer.invoke('desktop-overlay:ready'),
  reportSize: (size) => ipcRenderer.invoke('desktop-overlay:content-size', size)
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
