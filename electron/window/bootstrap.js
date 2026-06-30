'use strict';

const { BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const { getNativeCaptureCapabilities } = require('../native/capture');
const { getNativeCaptureInjectScript } = require('../policies/native-capture');
const { getMediaDeviceFilterInjectScript } = require('../policies/media-device');
const { WINDOW_BACKGROUND } = require('../shell-theme');

function showRendererRecovery(window, details = {}, { log } = {}) {
  if (!window || window.isDestroyed()) return;

  log?.error?.('Renderer process gone:', details);
  window.loadFile(path.join(__dirname, '../ui/renderer-recovery.html')).catch((error) => {
    log?.error?.('Failed to open recovery screen:', error);
  });
}

function loadMainApplication(window, appUrl, { dialog: dialogModule = dialog } = {}) {
  if (!appUrl) {
    dialogModule.showErrorBox('Voice Room', 'Не задан VOICE_ROOM_URL. Создайте .env или electron/runtime-config.json.');
    return Promise.resolve();
  }

  return window.loadURL(appUrl).catch((error) => {
    dialogModule.showErrorBox('Voice Room', `Не удалось открыть ${appUrl}\n\n${error.message}`);
  });
}

function installMediaDeviceFilter(webContents, { log } = {}) {
  const script = getMediaDeviceFilterInjectScript();

  const inject = () => {
    if (webContents.isDestroyed()) return;
    webContents.executeJavaScript(script, true).catch((error) => {
      log?.warn?.('Failed to install media device filter:', error);
    });
  };

  webContents.on('dom-ready', inject);
  webContents.on('did-navigate-in-page', inject);
}

function installNativeCaptureBridge(webContents, { log } = {}) {
  if (process.platform !== 'win32') return;

  const capabilities = getNativeCaptureCapabilities();
  if (!capabilities.available) {
    log?.info?.('Native cursor-correct capture is unavailable:', capabilities.reason);
    return;
  }

  const script = getNativeCaptureInjectScript();
  const inject = () => {
    if (webContents.isDestroyed()) return;
    webContents.executeJavaScript(script, true).catch((error) => {
      log?.warn?.('Failed to install native capture bridge:', error);
    });
  };

  webContents.on('dom-ready', inject);
  webContents.on('did-navigate-in-page', inject);
}

function installBuildLabel(webContents, { app, readBuildProfile, log } = {}) {
  const profile = readBuildProfile(app.getAppPath());
  const hash = profile?.buildHash || '';
  const text = hash ? `build: ${app.getVersion()} · ${hash}` : `build: ${app.getVersion()}`;
  const label = JSON.stringify(text);
  const script = `(function(){
    var id='voice-room-build-label';
    var existing=document.getElementById(id);
    if(existing){
      existing.textContent=${label};
      existing.style.left='auto';
      existing.style.right='8px';
      return;
    }
    var el=document.createElement('div');
    el.id=id;
    el.textContent=${label};
    el.style.cssText='position:fixed;right:8px;bottom:6px;z-index:2147483647;'+
      'font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;'+
      'color:currentColor;opacity:0.35;pointer-events:none;user-select:none;white-space:nowrap;';
    (document.body||document.documentElement).appendChild(el);
  })();`;

  const inject = () => {
    if (webContents.isDestroyed()) return;
    webContents.executeJavaScript(script, true).catch((error) => {
      log?.warn?.('Failed to inject build label:', error);
    });
  };

  webContents.on('dom-ready', inject);
  webContents.on('did-navigate-in-page', inject);
}

function createPickerPreviewWindow({ browserWindow = BrowserWindow, dialog: dialogModule = dialog } = {}) {
  const previewWindow = new browserWindow({
    backgroundColor: WINDOW_BACKGROUND,
    height: 760,
    minHeight: 640,
    minWidth: 760,
    show: false,
    title: 'Voice Room Stream Picker Preview',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    width: 1040
  });

  previewWindow.once('ready-to-show', () => {
    previewWindow.show();
  });

  previewWindow.loadFile(path.join(__dirname, '../ui/screen-picker-preview.html')).catch((error) => {
    dialogModule.showErrorBox('Voice Room', `Не удалось открыть preview\n\n${error.message}`);
  });
}

module.exports = {
  createPickerPreviewWindow,
  installBuildLabel,
  installMediaDeviceFilter,
  installNativeCaptureBridge,
  loadMainApplication,
  showRendererRecovery
};
