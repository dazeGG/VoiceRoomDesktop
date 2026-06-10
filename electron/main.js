'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  getNativeAudioCapabilities,
  startSafeSystemAudioCapture,
  stopSafeSystemAudioCapture
} = require('./native-audio');
const { runUpdateGate } = require('./update-gate');
const log = require('./logger');
const { WINDOW_BACKGROUND } = require('./shell-theme');
const {
  createScreenProfileId,
  normalizeDesktopAudioCapture,
  normalizeDesktopCapturePickerSelection,
  normalizeScreenFpsId,
  normalizeScreenQualityId
} = require('./desktop-capture-policy');

const runtimeConfig = readRuntimeConfig();
const APP_URL = process.env.VOICE_ROOM_URL || runtimeConfig.voiceRoomUrl || '';
const TRUSTED_ORIGIN = APP_URL ? new URL(APP_URL).origin : '';
const PICKER_PREVIEW_ENABLED = process.env.VOICE_ROOM_PICKER_PREVIEW === '1';
const DESKTOP_CAPTURE_PENDING_TTL_MS = 15_000;
const DESKTOP_CAPTURE_SOURCE_SNAPSHOT_TTL_MS = 30_000;
const pendingDesktopCaptureSources = new Map();
const desktopCaptureSourceSnapshots = new Map();
const desktopCapturePickerSessions = new Map();
let latestPendingDesktopCaptureSource = null;
let lastScreenCaptureSettingsOpenAt = 0;
let nextDesktopCapturePickerSessionId = 1;

const DESKTOP_DRAG_REGION_CSS = `
  body::before {
    -webkit-app-region: drag;
    content: "";
    position: fixed;
    top: 0;
    right: 0;
    left: 84px;
    height: 34px;
    z-index: 2147483647;
  }
`;

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

    const frameKey = getFrameKey(event.senderFrame);
    const sources = await getDesktopCaptureSources();
    if (frameKey) storeDesktopCaptureSourceSnapshot(frameKey, sources);

    return sources.map(serializeDesktopSource);
  });

  ipcMain.handle('desktop-capture:open-picker', async (event, options = {}) => {
    const frameKey = getFrameKey(event.senderFrame);
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const sources = await getDesktopCaptureSources();
    if (!sources.length) {
      throw new Error('Нет доступных источников экрана');
    }

    const selection = await openDesktopCapturePickerWindow(parentWindow, sources, options);
    if (selection.cancelled) {
      return {
        cancelled: true,
        ok: false
      };
    }

    const source = sources.find((item) => item.id === selection.sourceId);
    if (!source) {
      throw new Error('Desktop capture source is no longer available.');
    }

    const audioOptions = {
      allowEchoFallback: false,
      enabled: selection.streamAudioEnabled,
      mode: 'safe-system'
    };
    const audioCapture = setPendingDesktopCaptureSource(frameKey, source, audioOptions);

    return {
      audioCapture,
      fpsId: selection.fpsId,
      ok: true,
      profileId: createScreenProfileId(selection.qualityId, selection.fpsId),
      qualityId: selection.qualityId,
      source: serializeDesktopSource(source),
      streamAudioEnabled: selection.streamAudioEnabled
    };
  });

  ipcMain.handle('desktop-capture:select-source', async (event, sourceId, audioOptions = 'loopback') => {
    const frameKey = getFrameKey(event.senderFrame);
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const source = await getDesktopCaptureSourceForSelection(frameKey, sourceId);
    if (!source) {
      throw new Error('Desktop capture source is no longer available.');
    }

    const audioCapture = setPendingDesktopCaptureSource(frameKey, source, audioOptions);
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

    const session = startSafeSystemAudioCapture(event.sender, options);
    return { sessionId: session.sessionId };
  });

  ipcMain.handle('desktop-audio:open-settings', (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    if (process.platform === 'darwin') {
      openMacScreenCaptureSettings({ force: true });
      return { ok: true, target: 'mac-screen-capture' };
    }

    return { ok: false, target: '' };
  });

  ipcMain.handle('desktop-audio:stop', (event, sessionId = '') => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    return stopSafeSystemAudioCapture(sessionId);
  });
}

function configureScreenPickerIpc() {
  ipcMain.handle('screen-picker:get-state', (event) => {
    const session = getDesktopCapturePickerSessionForEvent(event);
    return {
      defaultFpsId: session.defaultFpsId,
      defaultQualityId: session.defaultQualityId,
      defaultStreamAudioEnabled: session.defaultStreamAudioEnabled,
      sources: session.sources.map(serializeDesktopSource)
    };
  });

  ipcMain.handle('screen-picker:select', (event, selection = {}) => {
    const session = getDesktopCapturePickerSessionForEvent(event);
    resolveDesktopCapturePickerSession(session, normalizeDesktopCapturePickerSelection(selection));
    return { ok: true };
  });

  ipcMain.handle('screen-picker:cancel', (event) => {
    const session = getDesktopCapturePickerSessionForEvent(event);
    cancelDesktopCapturePickerSession(session);
    return { ok: true };
  });
}

function getDesktopAudioCapabilities() {
  const nativeCapabilities = getNativeAudioCapabilities();
  return {
    label: 'Звук стрима',
    ...nativeCapabilities
  };
}

function setPendingDesktopCaptureSource(frameKey, source, audioOptions = 'loopback') {
  const previous = frameKey ? pendingDesktopCaptureSources.get(frameKey) : null;
  if (previous?.timer) clearTimeout(previous.timer);

  const timer = setTimeout(() => {
    if (frameKey) pendingDesktopCaptureSources.delete(frameKey);
    if (latestPendingDesktopCaptureSource?.source.id === source.id) {
      latestPendingDesktopCaptureSource = null;
    }
  }, DESKTOP_CAPTURE_PENDING_TTL_MS);
  timer.unref?.();

  const audioCapture = normalizeDesktopAudioCapture(source, audioOptions, getNativeAudioCapabilities());
  const pendingSource = {
    audioCapture,
    source,
    timer
  };

  if (frameKey) pendingDesktopCaptureSources.set(frameKey, pendingSource);
  latestPendingDesktopCaptureSource = {
    audioCapture: pendingSource.audioCapture,
    expiresAt: Date.now() + DESKTOP_CAPTURE_PENDING_TTL_MS,
    source
  };

  return audioCapture;
}

async function getDesktopCaptureSources() {
  assertMacScreenCaptureAccess();

  const sources = await desktopCapturer
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
  return sources.filter((source) => !isOwnDesktopCaptureSource(source));
}

function isOwnDesktopCaptureSource(source) {
  if (!source?.id?.startsWith('window:')) return false;
  return getOwnDesktopCaptureSourceIds().has(source.id);
}

function getOwnDesktopCaptureSourceIds() {
  const ids = new Set();
  for (const window of BrowserWindow.getAllWindows()) {
    const mediaSourceId = window.getMediaSourceId?.();
    if (mediaSourceId) ids.add(mediaSourceId);
  }
  return ids;
}

function storeDesktopCaptureSourceSnapshot(frameKey, sources) {
  clearDesktopCaptureSourceSnapshot(frameKey);

  const timer = setTimeout(() => {
    clearDesktopCaptureSourceSnapshot(frameKey);
  }, DESKTOP_CAPTURE_SOURCE_SNAPSHOT_TTL_MS);
  timer.unref?.();

  desktopCaptureSourceSnapshots.set(frameKey, {
    expiresAt: Date.now() + DESKTOP_CAPTURE_SOURCE_SNAPSHOT_TTL_MS,
    sources: new Map(sources.map((source) => [source.id, source])),
    timer
  });
}

function clearDesktopCaptureSourceSnapshot(frameKey) {
  const snapshot = desktopCaptureSourceSnapshots.get(frameKey);
  if (snapshot?.timer) clearTimeout(snapshot.timer);
  desktopCaptureSourceSnapshots.delete(frameKey);
}

async function getDesktopCaptureSourceForSelection(frameKey, sourceId) {
  const snapshotSource = getDesktopCaptureSourceFromSnapshot(frameKey, sourceId);
  if (snapshotSource) return snapshotSource;

  const sources = await getDesktopCaptureSources();
  return sources.find((source) => source.id === sourceId) || null;
}

function getDesktopCaptureSourceFromSnapshot(frameKey, sourceId) {
  const snapshot = frameKey ? desktopCaptureSourceSnapshots.get(frameKey) : null;
  if (!snapshot) return null;

  if (snapshot.expiresAt < Date.now()) {
    clearDesktopCaptureSourceSnapshot(frameKey);
    return null;
  }

  return snapshot.sources.get(sourceId) || null;
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

function openMacScreenCaptureSettings(options = {}) {
  const now = Date.now();
  if (!options.force && now - lastScreenCaptureSettingsOpenAt < 5000) return;

  lastScreenCaptureSettingsOpenAt = now;
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch((error) => {
    log.warn('Failed to open macOS Screen Recording settings:', error);
  });
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
    return null;
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

function openDesktopCapturePickerWindow(parentWindow, sources, options = {}) {
  const sessionId = String(nextDesktopCapturePickerSessionId++);
  const pickerWindow = new BrowserWindow({
    backgroundColor: WINDOW_BACKGROUND,
    height: 760,
    minHeight: 640,
    minWidth: 760,
    modal: Boolean(parentWindow),
    parent: parentWindow || undefined,
    show: false,
    title: 'Voice Room Stream Picker',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'screen-picker-preload.js'),
      sandbox: true
    },
    width: 1040
  });

  return new Promise((resolve, reject) => {
    const session = {
      defaultFpsId: normalizeScreenFpsId(options.fpsId),
      defaultQualityId: normalizeScreenQualityId(options.qualityId),
      defaultStreamAudioEnabled: options.streamAudioEnabled !== false,
      reject,
      resolve,
      sessionId,
      settled: false,
      sources,
      window: pickerWindow
    };
    desktopCapturePickerSessions.set(sessionId, session);

    pickerWindow.once('ready-to-show', () => {
      pickerWindow.show();
    });
    pickerWindow.once('closed', () => {
      if (!session.settled) {
        cancelDesktopCapturePickerSession(session);
      }
    });
    pickerWindow.loadFile(path.join(__dirname, 'screen-picker-preview.html'), {
      query: { sessionId }
    }).catch((error) => {
      rejectDesktopCapturePickerSession(session, error);
    });
  });
}

function getDesktopCapturePickerSessionForEvent(event) {
  const sessionId = getScreenPickerSessionId(event.senderFrame?.url || '');
  const session = sessionId ? desktopCapturePickerSessions.get(sessionId) : null;
  if (!session || session.window.webContents !== event.sender) {
    throw new Error('Screen picker session is not available.');
  }
  return session;
}

function getScreenPickerSessionId(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get('sessionId') || '';
  } catch {
    return '';
  }
}

function resolveDesktopCapturePickerSession(session, selection) {
  if (session.settled) return;
  session.settled = true;
  desktopCapturePickerSessions.delete(session.sessionId);

  if (!session.sources.some((source) => source.id === selection.sourceId)) {
    session.reject(new Error('Выбранный источник больше недоступен.'));
  } else {
    session.resolve(selection);
  }

  if (!session.window.isDestroyed()) session.window.close();
}

function cancelDesktopCapturePickerSession(session) {
  if (session.settled) return;
  session.settled = true;
  desktopCapturePickerSessions.delete(session.sessionId);
  session.resolve({
    cancelled: true,
    ok: false
  });
  if (!session.window.isDestroyed()) session.window.close();
}

function rejectDesktopCapturePickerSession(session, error) {
  if (session.settled) return;
  session.settled = true;
  desktopCapturePickerSessions.delete(session.sessionId);
  session.reject(error);
  if (!session.window.isDestroyed()) session.window.close();
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

  ipcMain.handle('window:reload-main', (event) => {
    const frameUrl = event.senderFrame?.url || '';
    if (!frameUrl.includes('renderer-recovery.html')) {
      throw new Error('Reload is only available from the recovery screen.');
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return { ok: false };

    return loadMainApplication(window).then(() => ({ ok: true }));
  });
}

function isRecoveryUrl(rawUrl) {
  return String(rawUrl || '').includes('renderer-recovery.html');
}

function showRendererRecovery(window, details = {}) {
  if (!window || window.isDestroyed()) return;

  log.error('Renderer process gone:', details);
  window.loadFile(path.join(__dirname, 'renderer-recovery.html')).catch((error) => {
    log.error('Failed to open recovery screen:', error);
  });
}

function loadMainApplication(window) {
  if (!APP_URL) {
    dialog.showErrorBox('Voice Room', 'Не задан VOICE_ROOM_URL. Создайте .env или electron/runtime-config.json.');
    return Promise.resolve();
  }

  return window.loadURL(APP_URL).catch((error) => {
    dialog.showErrorBox('Voice Room', `Не удалось открыть ${APP_URL}\n\n${error.message}`);
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
        log.error('Display media request failed:', error);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

function createWindow() {
  if (PICKER_PREVIEW_ENABLED) {
    createPickerPreviewWindow();
    return;
  }

  if (!APP_URL) {
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
    showRendererRecovery(mainWindow, details);
  });

  if (process.platform === 'darwin') {
    mainWindow.webContents.on('did-finish-load', () => {
      if (isRecoveryUrl(mainWindow.webContents.getURL())) return;
      mainWindow.webContents.insertCSS(DESKTOP_DRAG_REGION_CSS).catch((error) => {
        log.warn('Failed to inject desktop drag region CSS:', error);
      });
    });
  }

  loadMainApplication(mainWindow);
}

function createPickerPreviewWindow() {
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

  previewWindow.loadFile(path.join(__dirname, 'screen-picker-preview.html')).catch((error) => {
    dialog.showErrorBox('Voice Room', `Не удалось открыть preview\n\n${error.message}`);
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

  async function launchApplication() {
    configurePermissions();
    configureDesktopCaptureIpc();
    configureScreenPickerIpc();
    configureWindowIpc();

    const gate = await runUpdateGate({ previewEnabled: PICKER_PREVIEW_ENABLED });
    if (gate.ok) createWindow();
  }

  app.whenReady().then(() => {
    launchApplication().catch((error) => {
      log.error('Application launch failed:', error);
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        launchApplication().catch((error) => {
          log.error('Application relaunch failed:', error);
          app.quit();
        });
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
