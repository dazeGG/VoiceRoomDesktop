'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  getNativeAudioCapabilities,
  startSafeSystemAudioCapture,
  stopSafeSystemAudioCapture
} = require('./native-audio');

const runtimeConfig = readRuntimeConfig();
const APP_URL = process.env.VOICE_ROOM_URL || runtimeConfig.voiceRoomUrl || '';
const TRUSTED_ORIGIN = APP_URL ? new URL(APP_URL).origin : '';
const pendingDesktopCaptureSources = new Map();
let latestPendingDesktopCaptureSource = null;
let lastScreenCaptureSettingsOpenAt = 0;

const DESKTOP_AUDIO_MODES = new Set([
  'none',
  'loopback',
  'safe-system',
  'application'
]);

function readRuntimeConfig() {
  const configPath = path.join(__dirname, 'runtime-config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function isTrustedUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin === TRUSTED_ORIGIN;
  } catch {
    return false;
  }
}

function isTrustedFrame(frame) {
  return Boolean(frame?.url && isTrustedUrl(frame.url));
}

function getFrameKey(frame) {
  if (!frame || typeof frame.processId !== 'number' || typeof frame.routingId !== 'number') return '';
  return `${frame.processId}:${frame.routingId}`;
}

function serializeDesktopSource(source) {
  const thumbnail = source.thumbnail && !source.thumbnail.isEmpty()
    ? source.thumbnail.resize({ height: 180 }).toDataURL()
    : '';
  const appIcon = source.appIcon && !source.appIcon.isEmpty()
    ? source.appIcon.resize({ height: 32 }).toDataURL()
    : '';

  return {
    appIcon,
    id: source.id,
    name: source.name,
    thumbnail,
    type: source.id.startsWith('screen:') ? 'screen' : 'window'
  };
}

function configureDesktopCaptureIpc() {
  ipcMain.handle('desktop-capture:get-sources', async (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const sources = await getDesktopCaptureSources();

    return sources.map(serializeDesktopSource);
  });

  ipcMain.handle('desktop-capture:select-source', async (event, sourceId, audioOptions = 'loopback') => {
    const frameKey = getFrameKey(event.senderFrame);
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const sources = await getDesktopCaptureSources();
    const source = sources.find((item) => item.id === sourceId);
    if (!source) {
      throw new Error('Desktop capture source is no longer available.');
    }

    const previous = frameKey ? pendingDesktopCaptureSources.get(frameKey) : null;
    if (previous?.timer) clearTimeout(previous.timer);

    const timer = setTimeout(() => {
      if (frameKey) pendingDesktopCaptureSources.delete(frameKey);
      if (latestPendingDesktopCaptureSource?.source.id === source.id) {
        latestPendingDesktopCaptureSource = null;
      }
    }, 15_000);
    timer.unref?.();

    const audioCapture = normalizeDesktopAudioCapture(source, audioOptions);
    const pendingSource = {
      audioCapture,
      source,
      timer
    };
    if (frameKey) pendingDesktopCaptureSources.set(frameKey, pendingSource);
    latestPendingDesktopCaptureSource = {
      audioCapture: pendingSource.audioCapture,
      expiresAt: Date.now() + 15_000,
      source
    };
    return {
      audioCapture,
      ok: true
    };
  });

  ipcMain.handle('desktop-audio:get-capabilities', (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    return getDesktopAudioCapabilities();
  });

  ipcMain.handle('desktop-audio:start-safe-system', (event, options = {}) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    return startSafeSystemAudioCapture(event.sender, options);
  });

  ipcMain.handle('desktop-audio:stop', (event, sessionId = '') => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    return stopSafeSystemAudioCapture(sessionId);
  });
}

function getDesktopAudioCapabilities() {
  const nativeCapabilities = getNativeAudioCapabilities();
  return {
    label: 'Звук стрима',
    ...nativeCapabilities
  };
}

function normalizeDesktopAudioCapture(source, audioOptions) {
  const options = typeof audioOptions === 'object' && audioOptions !== null
    ? audioOptions
    : { mode: audioOptions };
  const enabled = options.enabled !== false && options.mode !== 'none';
  if (!enabled) {
    return {
      mode: 'none',
      requestedMode: 'none',
      sourceType: source.id.startsWith('screen:') ? 'screen' : 'window',
      warning: ''
    };
  }

  const requestedMode = DESKTOP_AUDIO_MODES.has(options.mode) ? options.mode : 'safe-system';
  const safeModeRequested = requestedMode === 'safe-system' || requestedMode === 'application';
  const nativeCapabilities = getNativeAudioCapabilities();
  if (safeModeRequested && nativeCapabilities.modes[modeToCapabilityKey(requestedMode)]) {
    return {
      mode: requestedMode,
      requestedMode,
      sourceType: source.id.startsWith('screen:') ? 'screen' : 'window',
      warning: ''
    };
  }

  if (safeModeRequested && options.allowEchoFallback === false) {
    return {
      mode: 'none',
      requestedMode,
      sourceType: source.id.startsWith('screen:') ? 'screen' : 'window',
      warning: 'safe-loopback-unavailable'
    };
  }

  return {
    mode: 'loopback',
    requestedMode,
    sourceType: source.id.startsWith('screen:') ? 'screen' : 'window',
    warning: safeModeRequested ? 'using-echo-prone-loopback' : ''
  };
}

function modeToCapabilityKey(mode) {
  if (mode === 'safe-system') return 'safeSystem';
  return mode;
}

function getDesktopCaptureSources() {
  assertMacScreenCaptureAccess();

  return desktopCapturer
    .getSources({
      fetchWindowIcons: true,
      thumbnailSize: { height: 360, width: 640 },
      types: ['screen', 'window']
    })
    .catch((error) => {
      if (process.platform === 'darwin') {
        openMacScreenCaptureSettings();
        throw createMacScreenCaptureAccessError(error);
      }

      throw error;
    });
}

function assertMacScreenCaptureAccess() {
  if (process.platform !== 'darwin') return;

  const status = getMacScreenCaptureStatus();
  if (status === 'granted' || status === 'unknown') return;

  openMacScreenCaptureSettings();
  throw createMacScreenCaptureAccessError();
}

function getMacScreenCaptureStatus() {
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

function createMacScreenCaptureAccessError(cause) {
  const status = getMacScreenCaptureStatus();
  const appName = app.getName() || 'Voice Room';
  const devHint = process.defaultApp ? ' При запуске через npm run electron разрешение может называться Electron.' : '';
  const causeText = cause?.message ? `\nElectron: ${cause.message}` : '';
  const error = new Error(
    [
      'macOS не дала приложению доступ к записи экрана.',
      `Статус Screen Recording: ${status}.`,
      `Откройте System Settings -> Privacy & Security -> Screen & System Audio Recording и включите ${appName}.${devHint}`,
      'После изменения полностью закройте и снова откройте приложение.'
    ].join('\n') + causeText
  );
  error.name = 'ScreenCapturePermissionError';
  return error;
}

function openMacScreenCaptureSettings() {
  const now = Date.now();
  if (now - lastScreenCaptureSettingsOpenAt < 5000) return;

  lastScreenCaptureSettingsOpenAt = now;
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => {});
}

function takePendingDesktopCaptureSource(frame) {
  const frameKey = getFrameKey(frame);
  if (frameKey) {
    const pending = pendingDesktopCaptureSources.get(frameKey);
    pendingDesktopCaptureSources.delete(frameKey);
    if (pending?.timer) clearTimeout(pending.timer);
    if (pending?.source) {
      clearPendingDesktopCaptureSource(pending.source.id);
      return pending;
    }
  }

  if (!latestPendingDesktopCaptureSource || latestPendingDesktopCaptureSource.expiresAt < Date.now()) {
    latestPendingDesktopCaptureSource = null;
    return null;
  }

  const { audioCapture, source } = latestPendingDesktopCaptureSource;
  clearPendingDesktopCaptureSource(source.id);
  return { audioCapture, source };
}

function clearPendingDesktopCaptureSource(sourceId) {
  if (latestPendingDesktopCaptureSource?.source.id === sourceId) {
    latestPendingDesktopCaptureSource = null;
  }

  for (const [frameKey, pending] of pendingDesktopCaptureSources.entries()) {
    if (pending.source.id !== sourceId) continue;
    if (pending.timer) clearTimeout(pending.timer);
    pendingDesktopCaptureSources.delete(frameKey);
  }
}

function configureWindowIpc() {
  ipcMain.handle('window:set-fullscreen', (event, fullscreen) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Window controls are only available for the configured Voice Room URL.');
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    window.setFullScreen(Boolean(fullscreen));
    return window.isFullScreen();
  });

  ipcMain.handle('window:is-fullscreen', (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Window controls are only available for the configured Voice Room URL.');
    }

    return Boolean(BrowserWindow.fromWebContents(event.sender)?.isFullScreen());
  });
}

function configurePermissions() {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = new Set(['display-capture', 'fullscreen', 'media', 'mediaKeySystem', 'clipboard-sanitized-write']);
    const allowed = allowedPermissions.has(permission) && isTrustedUrl(webContents.getURL());
    callback(allowed);
  });

  defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const allowedPermissions = new Set(['display-capture', 'fullscreen', 'media', 'mediaKeySystem', 'clipboard-sanitized-write']);
    return Boolean(TRUSTED_ORIGIN) && allowedPermissions.has(permission) && requestingOrigin === TRUSTED_ORIGIN && isTrustedUrl(webContents.getURL());
  });

  defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!isTrustedFrame(request.frame)) {
        callback({});
        return;
      }

      const pending = takePendingDesktopCaptureSource(request.frame);
      if (!pending?.source) {
        callback({});
        return;
      }

      try {
        const canCaptureLoopbackAudio = request.audioRequested
          && pending.audioCapture?.mode === 'loopback';
        const response = { video: pending.source };
        if (canCaptureLoopbackAudio) response.audio = 'loopback';
        callback(response);
      } catch (error) {
        console.error('Display media request failed:', error);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

function createWindow() {
  if (!APP_URL) {
    dialog.showErrorBox('Voice Room', 'Не задан VOICE_ROOM_URL. Создайте .env или electron/runtime-config.json.');
    app.quit();
    return;
  }

  const mainWindow = new BrowserWindow({
    backgroundColor: '#10110f',
    height: 820,
    minHeight: 620,
    minWidth: 420,
    show: false,
    title: 'Voice Room',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true
    },
    width: 1180
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details);
  });

  mainWindow.loadURL(APP_URL).catch((error) => {
    dialog.showErrorBox('Voice Room', `Не удалось открыть ${APP_URL}\n\n${error.message}`);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    configurePermissions();
    configureDesktopCaptureIpc();
    configureWindowIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
