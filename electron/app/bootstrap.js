'use strict';

const { getLocale, t } = require('../localization');

const { net, session } = require('electron');
const path = require('node:path');
const { WINDOW_BACKGROUND, getMainWindowChromeOptions } = require('../shell-theme');
const { MIN_WINDOW_SIZE } = require('../window/state');
const {
  createAppTopbarView,
  installDesktopLayoutCss
} = require('../window/app-topbar-view');

const { createConnectionRecovery, createOutageReporter } = require('../window/connection-recovery');
const { checkSiteAvailability } = require('../policies/update-gate-state');

function createAppBootstrap({
  app,
  openAdmin,
  classifyAppUrl,
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
  showConnectionLost,
  installMediaDeviceFilter,
  installNativeCaptureBridge,
  installBuildLabel,
  showRendererRecovery,
  windowLifecycle,
  windowState,
  onMainWindowCreated = () => {},
  resolveLaunchUrl = () => appUrl,
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

  function createWindow({ startHidden = false } = {}) {
    if (previewEnabled) {
      const previewWindow = new BrowserWindow({
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
        dialog.showErrorBox('VoiceRoom', t('previewError', { error: error.message }));
      });
      return;
    }

    if (!appUrl) {
      dialog.showErrorBox('VoiceRoom', t('missingUrl'));
      app.quit();
      return;
    }

    const initialWindowState = windowState.resolveInitialState();
    log.info('Restoring main window:', initialWindowState);
    // Size only: the position is applied with setBounds below, which keeps the
    // size right on a monitor scaled differently from the primary one.
    const mainWindow = new BrowserWindow({
      backgroundColor: WINDOW_BACKGROUND,
      height: initialWindowState.bounds.height,
      width: initialWindowState.bounds.width,
      minHeight: MIN_WINDOW_SIZE.height,
      minWidth: MIN_WINDOW_SIZE.width,
      show: false,
      title: 'VoiceRoom',
      ...getMainWindowChromeOptions(process.platform),
      webPreferences: {
        additionalArguments: [`--voice-room-desktop-version=${app.getVersion()}`],
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '../preload.js'),
        sandbox: true
      }
    });
    windowState.applyBounds(mainWindow, initialWindowState.bounds);
    // maximize() also shows the window, so a hidden launch defers it until the
    // user opens the window from the tray or the Dock.
    if (startHidden) {
      if (initialWindowState.isMaximized) mainWindow.once('show', () => mainWindow.maximize());
    } else {
      mainWindow.once('ready-to-show', () => {
        if (initialWindowState.isMaximized) mainWindow.maximize();
        mainWindow.show();
      });
    }
    windowState.track(mainWindow, { isMaximized: initialWindowState.isMaximized });

    installMediaDeviceFilter(mainWindow.webContents, { log });
    installNativeCaptureBridge(mainWindow.webContents, { log });
    installBuildLabel(mainWindow.webContents, { app, log, readBuildProfile });
    devDiagnostics.installDevDiagnosticsShortcut(mainWindow);
    windowLifecycle.attachMainWindow(mainWindow);
    windowLifecycle.installTray();
    onMainWindowCreated(mainWindow);

    const appTopbarView = createAppTopbarView({ log, platform: process.platform });
    appTopbarView.attach(mainWindow);
    mainWindow.once('closed', () => {
      appTopbarView.destroy();
    });

    installDesktopLayoutCss(mainWindow.webContents, desktopLayoutCss, { log });

    // The main window stays on the site, so a call is not dropped. The admin
    // app opens in the system browser, and only for a staff session.
    const leaveSite = (url) => {
      if (classifyAppUrl(url) === 'admin') {
        void openAdmin(url);
        return;
      }
      shell.openExternal(url).catch((error) => {
        log.warn('Failed to open external URL:', url, error);
      });
    };

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isTrustedUrl(url)) return { action: 'allow' };
      leaveSite(url);
      return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (isTrustedUrl(url)) return;
      event.preventDefault();
      leaveSite(url);
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      showRendererRecovery(mainWindow, details, { log });
    });

    // Also what a launch to the tray relies on when it races the network at
    // login: the window stays hidden and keeps checking.
    const fetchFromSession = (...args) => session.defaultSession.fetch(...args);
    createConnectionRecovery({
      window: mainWindow,
      appUrl,
      isTrustedUrl,
      checkSite: () => checkSiteAvailability(appUrl, { fetchImpl: fetchFromSession }),
      showUnavailablePage: () => showConnectionLost(mainWindow),
      reportOutage: createOutageReporter({ appUrl, fetchImpl: fetchFromSession, log }),
      isOnline: () => net.isOnline(),
      log
    });

    loadMainApplication(mainWindow, resolveLaunchUrl(), { dialog, log });
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
