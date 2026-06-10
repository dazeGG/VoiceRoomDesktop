'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { shouldRunUpdateGateState } = require('./update-gate-policy');
const log = require('./logger');

const CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

let updateGateConfigured = false;

function shouldRunUpdateGate(options = {}) {
  return shouldRunUpdateGateState({
    isPackaged: app.isPackaged,
    previewEnabled: options.previewEnabled
  });
}

function getAutoUpdater() {
  return require('electron-updater').autoUpdater;
}

function formatBlockedMessage() {
  return 'Нет доступа к серверу обновлений. Проверьте подключение к интернету.';
}

function createUpdateSplashWindow() {
  const window = new BrowserWindow({
    backgroundColor: '#10110f',
    height: 320,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    title: 'Voice Room',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'update-preload.js'),
      sandbox: true
    },
    width: 460
  });

  window.setMenuBarVisibility(false);
  return window;
}

function sendState(window, state) {
  if (!window?.isDestroyed()) {
    window.webContents.send('update-gate:state', state);
  }
}

function configureUpdateGateIpc() {
  if (updateGateConfigured) return;
  updateGateConfigured = true;

  ipcMain.handle('update-gate:quit', () => {
    app.quit();
    return { ok: true };
  });
}

function attachAutoUpdaterHandlers(autoUpdater, handlers) {
  const events = [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error'
  ];

  for (const eventName of events) {
    autoUpdater.on(eventName, handlers[eventName]);
  }

  return () => {
    for (const eventName of events) {
      autoUpdater.removeListener(eventName, handlers[eventName]);
    }
  };
}

function runUpdateGate(options = {}) {
  configureUpdateGateIpc();

  if (!shouldRunUpdateGate(options)) {
    return Promise.resolve({ ok: true });
  }

  const autoUpdater = getAutoUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = true;

  const splash = createUpdateSplashWindow();

  return new Promise((resolve) => {
    let settled = false;
    let checkTimer = null;
    let downloadTimer = null;
    let detachHandlers = null;

    function clearTimers() {
      if (checkTimer) clearTimeout(checkTimer);
      if (downloadTimer) clearTimeout(downloadTimer);
      checkTimer = null;
      downloadTimer = null;
    }

    function cleanup() {
      clearTimers();
      detachHandlers?.();
      detachHandlers = null;
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      cleanup();
      if (!splash.isDestroyed()) splash.close();
      resolve(result);
    }

    function block() {
      if (settled) return;
      cleanup();
      sendState(splash, {
        blocked: true,
        message: formatBlockedMessage(),
        phase: 'blocked'
      });
    }

    detachHandlers = attachAutoUpdaterHandlers(autoUpdater, {
      'checking-for-update': () => {
        sendState(splash, {
          blocked: false,
          message: 'Проверка обновлений...',
          phase: 'checking',
          progress: null
        });
      },
      'update-available': () => {
        clearTimers();
        sendState(splash, {
          blocked: false,
          message: 'Загрузка обновления...',
          phase: 'downloading',
          progress: 0
        });
        downloadTimer = setTimeout(block, DOWNLOAD_TIMEOUT_MS);
        downloadTimer.unref?.();
        autoUpdater.downloadUpdate().catch((error) => {
          log.error('Update download failed:', error);
          block();
        });
      },
      'update-not-available': () => {
        finish({ ok: true });
      },
      'download-progress': (progress) => {
        sendState(splash, {
          blocked: false,
          message: 'Загрузка обновления...',
          phase: 'downloading',
          progress: Math.max(0, Math.min(100, Math.round(progress.percent || 0)))
        });
      },
      'update-downloaded': () => {
        clearTimers();
        sendState(splash, {
          blocked: false,
          message: 'Установка обновления...',
          phase: 'installing',
          progress: 100
        });
        setTimeout(() => {
          autoUpdater.quitAndInstall(true, true);
        }, 400);
      },
      error: (error) => {
        log.error('Auto-updater error:', error);
        block();
      }
    });

    splash.once('ready-to-show', () => {
      splash.show();
      sendState(splash, {
        blocked: false,
        message: 'Проверка обновлений...',
        phase: 'checking',
        progress: null
      });

      checkTimer = setTimeout(block, CHECK_TIMEOUT_MS);
      checkTimer.unref?.();

      autoUpdater.checkForUpdates().catch((error) => {
        log.error('Update check failed:', error);
        block();
      });
    });

    splash.loadFile(path.join(__dirname, 'update-splash.html')).catch((error) => {
      log.error('Failed to open update splash:', error);
      block();
    });
  });
}

module.exports = {
  runUpdateGate,
  shouldRunUpdateGate
};