'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceRoomScreenPicker', {
  cancel: () => ipcRenderer.invoke('screen-picker:cancel'),
  getState: () => ipcRenderer.invoke('screen-picker:get-state'),
  select: (selection) => ipcRenderer.invoke('screen-picker:select', selection)
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
