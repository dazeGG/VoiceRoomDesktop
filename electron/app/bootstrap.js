'use strict';

const { session } = require('electron');
const path = require('node:path');
const { WINDOW_BACKGROUND, getMainWindowChromeOptions } = require('../shell-theme');
const {
  createAppTopbarView,
  installDesktopLayoutCss
} = require('../window/app-topbar-view');

const HIDDEN_LOAD_RETRY_MS = 30_000;

function createAppBootstrap({
  app,
  BrowserWindow,
  dialog,
  shell,
  log,
  readBuildProfile,
  runUpdateGate,
  ensureMacMicrophoneAccess,
  grantMacMediaPermission,
  isPermissionContextTrusted,
  isTrustedDisplayMediaRequest,
  isTrustedUrl,
  configureDesktopCaptureIpc,
  configureScreenPickerIpc,
  recordGrantedDesktopCapture,
  takePendingDesktopCaptureSource,
  loadMainApplication,
  installMediaDeviceFilter,
  installNativeCaptureBridge,
  installBuildLabel,
  showRendererRecovery,
  windowLifecycle,
  devDiagnostics,
  previewEnabled,
  desktopLayoutCss,
  allowedSessionPermissions,
  appUrl
}) {
  function configurePermissions() {
    const defaultSession = session.defaultSession;

    defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
      if (!allowedSessionPermissions.has(permission)) {
        log.warn('Denied permission request:', permission);
        callback(false);
        return;
      }

      if (!isPermissionContextTrusted(webContents, details)) {
        log.warn(
          'Denied permission request from untrusted page:',
          permission,
          webContents?.getURL?.(),
          details.requestingUrl
        );
        callback(false);
        return;
      }

      if (permission === 'media' && process.platform === 'darwin') {
        grantMacMediaPermission(details).then((granted) => {
          if (!granted) {
            log.warn('macOS media access denied:', details.mediaTypes || []);
          }
          callback(granted);
        }).catch((error) => {
          log.error('macOS media access prompt failed:', error);
          callback(false);
        });
        return;
      }

      callback(true);
    });

    defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
      if (!allowedSessionPermissions.has(permission)) {
        return false;
      }
      return isPermissionContextTrusted(webContents, details, requestingOrigin);
    });

    defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        if (!isTrustedDisplayMediaRequest(request)) {
          callback({});
          return;
        }

        const pending = takePendingDesktopCaptureSource(request.frame, request.securityOrigin);
        if (!pending?.source) {
          callback({});
          return;
        }

        try {
          const canCaptureLoopbackAudio = request.audioRequested
            && pending.audioCapture?.mode === 'loopback';
          const response = { video: pending.source };
          if (canCaptureLoopbackAudio) response.audio = 'loopback';
          recordGrantedDesktopCapture(request.frame, pending);
          callback(response);
        } catch (error) {
          log.error('Display media request failed:', error);
          callback({});
        }
      },
      { useSystemPicker: false }
    );
  }

  // A hidden launch (autostart to tray) often races the network at login. Retry
  // quietly while the window stays in the tray instead of popping an error box;
  // once the user opens the window, fall back to the regular loud load.
  function loadMainApplicationInBackground(mainWindow) {
    let retryTimer = null;
    let settled = false;

    const loadVisibly = () => {
      settled = true;
      mainWindow.removeListener('show', onShow);
      loadMainApplication(mainWindow, appUrl, { dialog });
    };

    function onShow() {
      if (settled || !retryTimer) return;
      clearTimeout(retryTimer);
      retryTimer = null;
      loadVisibly();
    }

    const attempt = () => {
      retryTimer = null;
      if (mainWindow.isDestroyed()) return;
      mainWindow.loadURL(appUrl).then(() => {
        settled = true;
        mainWindow.removeListener('show', onShow);
      }).catch((error) => {
        if (mainWindow.isDestroyed() || settled) return;
        if (mainWindow.isVisible()) {
          loadVisibly();
          return;
        }
        log.warn('Voice Room is not reachable yet, retrying in the background:', error?.message || error);
        retryTimer = setTimeout(attempt, HIDDEN_LOAD_RETRY_MS);
      });
    };

    mainWindow.on('show', onShow);
    mainWindow.once('closed', () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    });
    attempt();
  }

  function createWindow({ startHidden = false } = {}) {
    if (previewEnabled) {
      const previewWindow = new BrowserWindow({
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
        dialog.showErrorBox('Voice Room', `Не удалось открыть preview\n\n${error.message}`);
      });
      return;
    }

    if (!appUrl) {
      dialog.showErrorBox('Voice Room', 'Не задан VOICE_ROOM_URL. Создайте .env или electron/runtime-config.json.');
      app.quit();
      return;
    }

    const mainWindow = new BrowserWindow({
      backgroundColor: WINDOW_BACKGROUND,
      height: 820,
      minHeight: 620,
      minWidth: 420,
      show: false,
      title: 'Voice Room',
      ...getMainWindowChromeOptions(process.platform),
      webPreferences: {
        additionalArguments: [`--voice-room-desktop-version=${app.getVersion()}`],
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '../preload.js'),
        sandbox: true
      },
      width: 1180
    });
    if (!startHidden) {
      mainWindow.once('ready-to-show', () => {
        mainWindow.show();
      });
    }

    installMediaDeviceFilter(mainWindow.webContents, { log });
    installNativeCaptureBridge(mainWindow.webContents, { log });
    installBuildLabel(mainWindow.webContents, { app, log, readBuildProfile });
    devDiagnostics.installDevDiagnosticsShortcut(mainWindow);
    windowLifecycle.attachMainWindow(mainWindow);
    windowLifecycle.installTray();

    const appTopbarView = createAppTopbarView({ log, platform: process.platform });
    appTopbarView.attach(mainWindow);
    mainWindow.once('closed', () => {
      appTopbarView.destroy();
    });

    installDesktopLayoutCss(mainWindow.webContents, desktopLayoutCss, { log });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isTrustedUrl(url)) return { action: 'allow' };
      shell.openExternal(url).catch((error) => {
        log.warn('Failed to open external URL:', url, error);
      });
      return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (isTrustedUrl(url)) return;
      event.preventDefault();
      shell.openExternal(url).catch((error) => {
        log.warn('Failed to open external URL:', url, error);
      });
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      showRendererRecovery(mainWindow, details, { log });
    });

    if (startHidden) {
      loadMainApplicationInBackground(mainWindow);
    } else {
      loadMainApplication(mainWindow, appUrl, { dialog });
    }
  }

  async function launchApplication({ startHidden = false } = {}) {
    configurePermissions();
    configureDesktopCaptureIpc();
    configureScreenPickerIpc();

    const micAccess = await ensureMacMicrophoneAccess();
    if (!micAccess.granted && micAccess.status === 'denied') {
      log.warn('Microphone access denied in macOS privacy settings.');
    }

    const gate = await runUpdateGate({ appUrl, previewEnabled, silent: startHidden });
    if (gate.ok) createWindow({ startHidden });
    return gate;
  }

  return {
    configurePermissions,
    createWindow,
    launchApplication
  };
}

module.exports = { createAppBootstrap };
