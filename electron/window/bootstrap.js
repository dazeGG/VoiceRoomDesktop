'use strict';

const { getLocale, t } = require('../localization');

const { BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const { getNativeCaptureCapabilities } = require('../native/capture');
const { getNativeCaptureInjectScript } = require('../policies/native-capture');
const { getMediaDeviceFilterInjectScript } = require('../policies/media-device');
const { WINDOW_BACKGROUND } = require('../shell-theme');

function showRendererRecovery(window, details = {}, { log } = {}) {
  if (!window || window.isDestroyed()) return;

  log?.error?.('Renderer process gone:', details);
  window.loadFile(path.join(__dirname, '../ui/renderer-recovery.html'), { query: { locale: getLocale() } }).catch((error) => {
    log?.error?.('Failed to open recovery screen:', error);
  });
}

function loadMainApplication(window, appUrl, { dialog: dialogModule = dialog, log } = {}) {
  if (!appUrl) {
    dialogModule.showErrorBox('VoiceRoom', t('missingUrl'));
    return Promise.resolve();
  }

  // A failure here is also a did-fail-load, which brings up the connection screen.
  return window.loadURL(appUrl).catch((error) => {
    log?.warn?.('Failed to load VoiceRoom:', error?.message || error);
  });
}

function showConnectionLost(window) {
  return window.loadFile(path.join(__dirname, '../ui/connection-lost.html'), { query: { locale: getLocale() } });
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

function createPickerPreviewWindow({ browserWindow = BrowserWindow, dialog: dialogModule = dialog } = {}) {
  const previewWindow = new browserWindow({
    backgroundColor: WINDOW_BACKGROUND,
    height: 760,
    minHeight: 640,
    minWidth: 760,
    show: false,
    title: t('previewTitle'),
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

  previewWindow.loadFile(path.join(__dirname, '../ui/screen-picker-preview.html'), { query: { locale: getLocale() } }).catch((error) => {
    dialogModule.showErrorBox('VoiceRoom', t('previewError', { error: error.message }));
  });
}

module.exports = {
  createPickerPreviewWindow,
  installMediaDeviceFilter,
  installNativeCaptureBridge,
  loadMainApplication,
  showConnectionLost,
  showRendererRecovery
};
