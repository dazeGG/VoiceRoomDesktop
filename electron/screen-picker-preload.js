'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceRoomScreenPicker', {
  cancel: () => ipcRenderer.invoke('screen-picker:cancel'),
  getState: () => ipcRenderer.invoke('screen-picker:get-state'),
  select: (selection) => ipcRenderer.invoke('screen-picker:select', selection)
});
