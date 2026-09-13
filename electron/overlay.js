'use strict';

const path = require('node:path');
const { bindingToAccelerator } = require('./hotkeys');
const { createDesktopSettingsStore } = require('./desktop-settings');
const { createForegroundWatcher } = require('./overlay-foreground');
const {
  classifyForegroundApp,
  describeForeground,
  fileName,
  parseForegroundPayload
} = require('./policies/overlay-games');
const {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_MARGIN_PX,
  describeInteractiveHotkey,
  isOverlayHtmlUrl,
  resolveOverlayBounds,
  sanitizeOverlaySettings,
  sanitizeOverlaySnapshot,
  shouldShowOverlay
} = require('./policies/overlay');

const GET_CHANNEL = 'desktop-overlay:get-settings';
const SET_CHANNEL = 'desktop-overlay:set-settings';
const SNAPSHOT_CHANNEL = 'desktop-overlay:set-snapshot';
const PREVIEW_CHANNEL = 'desktop-overlay:preview';
const STATE_CHANNEL = 'desktop-overlay:state';
const ACTION_CHANNEL = 'desktop-overlay:action';
const SIZE_CHANNEL = 'desktop-overlay:content-size';
const READY_CHANNEL = 'desktop-overlay:ready';
const SUSPEND_CHANNEL = 'desktop-overlay:set-suspended';
const FOREGROUND_CHANNEL = 'desktop-overlay:get-foreground';
const ADD_GAME_CHANNEL = 'desktop-overlay:add-game';
const REMOVE_GAME_CHANNEL = 'desktop-overlay:remove-game';
const PREVIEW_MS = 8_000;
const MIN_OVERLAY_WIDTH = 220;
const MIN_OVERLAY_HEIGHT = 72;

function createOverlayController({
  BrowserWindow,
  globalShortcut,
  screen,
  app,
  fs,
  path: pathModule = path,
  log = console,
  callControls,
  platform = process.platform,
  createForegroundWatcher: createWatcher = createForegroundWatcher
}) {
  const settingsStore = createDesktopSettingsStore({ app, fs, log, path: pathModule });
  let overlayWindow = null;
  let mainWindow = null;
  let mainListeners = [];
  let interactive = false;
  let previewTimer = null;
  let previewing = false;
  let snapshot = sanitizeOverlaySnapshot(null);
  let settings = loadSettings();
  let registeredAccelerator = null;
  let suspended = false;
  let contentSize = { height: 132, width: 280 };
  let disposing = false;
  let foreground = null;
  let activeGame = null;
  const watcher = createWatcher({
    log,
    onChange: handleForeground,
    platform
  });

  function loadSettings() {
    return sanitizeOverlaySettings(settingsStore.read().overlay);
  }

  function persistSettings(next) {
    settings = sanitizeOverlaySettings(next);
    settingsStore.patch({ overlay: { ...settings } });
    return getSettings();
  }

  function getSettings() {
    return { ...settings, allowedExecutables: [...settings.allowedExecutables] };
  }

  function classifyCurrent(payload = foreground) {
    if (!payload) return classifyForegroundApp(null, { allowedExecutables: settings.allowedExecutables });
    return classifyForegroundApp(payload, { allowedExecutables: settings.allowedExecutables });
  }

  function handleForeground(raw) {
    const payload = parseForegroundPayload(raw) || raw;
    if (!payload?.exe) return;
    foreground = payload;
    const classification = classifyCurrent(payload);
    activeGame = classification.game
      ? { ...classification, bounds: payload.bounds, title: payload.title }
      : null;
    syncWindow();
  }

  function isVisibleNow() {
    return shouldShowOverlay({
      callActive: callControls.getState().active === true,
      enabled: settings.enabled,
      gameActive: Boolean(activeGame),
      interactive,
      previewing
    });
  }

  function toDipBounds(bounds) {
    if (!bounds || bounds.width < 64 || bounds.height < 64) return null;
    try {
      if (typeof screen.screenToDipRect === 'function') {
        return screen.screenToDipRect(null, bounds);
      }
    } catch {
      // Fall through to identity; PowerShell's GetWindowRect is often already DIP.
    }
    return bounds;
  }

  function targetWorkArea() {
    const gameArea = toDipBounds(activeGame?.bounds);
    if (gameArea) return gameArea;
    try {
      const display = screen.getPrimaryDisplay?.();
      return display?.workArea || display?.bounds || { height: 720, width: 1280, x: 0, y: 0 };
    } catch {
      return { height: 720, width: 1280, x: 0, y: 0 };
    }
  }

  function viewState() {
    const call = callControls.getState();
    return {
      call: {
        active: call.active === true,
        micMuted: call.micMuted === true,
        outputMuted: call.outputMuted === true,
        roomName: call.roomName || ''
      },
      hint: interactive ? describeInteractiveHotkey(settings.interactiveBinding) : '',
      interactive,
      participants: settings.showParticipants ? snapshot.participants : [],
      previewing,
      settings: {
        clickThrough: settings.clickThrough,
        opacity: settings.opacity,
        showControls: settings.showControls,
        showParticipants: settings.showParticipants
      }
    };
  }

  function sendState() {
    if (!overlayWindow || overlayWindow.isDestroyed?.()) return;
    overlayWindow.webContents?.send?.(STATE_CHANNEL, viewState());
  }

  function applyClickThrough() {
    if (!overlayWindow || overlayWindow.isDestroyed?.()) return;
    const ignore = interactive ? false : settings.clickThrough !== false;
    overlayWindow.setIgnoreMouseEvents?.(ignore, { forward: true });
    overlayWindow.setFocusable?.(!ignore);
  }

  function positionWindow() {
    if (!overlayWindow || overlayWindow.isDestroyed?.()) return;
    const bounds = resolveOverlayBounds({
      anchor: settings.anchor,
      height: contentSize.height,
      margin: OVERLAY_MARGIN_PX,
      width: contentSize.width,
      workArea: targetWorkArea()
    });
    overlayWindow.setBounds?.(bounds);
  }

  function applyAlwaysOnTop() {
    if (!overlayWindow || overlayWindow.isDestroyed?.()) return;
    overlayWindow.setAlwaysOnTop?.(true, 'screen-saver', 1);
    overlayWindow.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  }

  function ensureWindow() {
    if (overlayWindow && !overlayWindow.isDestroyed?.()) return overlayWindow;

    overlayWindow = new BrowserWindow({
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: '#00000000',
      focusable: false,
      frame: false,
      roundedCorners: false,
      fullscreenable: false,
      hasShadow: false,
      height: contentSize.height,
      maximizable: false,
      minimizable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      thickFrame: false,
      title: 'Voice Room Overlay',
      transparent: true,
      width: contentSize.width,
      ...(platform === 'darwin' ? { type: 'panel', visualEffectState: 'active' } : {}),
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: pathModule.join(__dirname, 'ui/overlay-preload.js'),
        sandbox: true
      }
    });

    overlayWindow.setMenuBarVisibility?.(false);
    applyAlwaysOnTop();
    applyClickThrough();

    overlayWindow.on?.('close', (event) => {
      if (disposing) return;
      event.preventDefault?.();
      hideWindow();
    });

    overlayWindow.once?.('closed', () => {
      overlayWindow = null;
    });

    overlayWindow.loadFile(pathModule.join(__dirname, 'ui/overlay.html')).catch((error) => {
      log.warn?.('Failed to load overlay window:', error);
    });
    return overlayWindow;
  }

  function hideWindow() {
    interactive = false;
    if (!overlayWindow || overlayWindow.isDestroyed?.()) return;
    applyClickThrough();
    overlayWindow.hide?.();
  }

  function showWindow() {
    const window = ensureWindow();
    positionWindow();
    applyAlwaysOnTop();
    applyClickThrough();
    sendState();
    if (window.isVisible?.() !== true) {
      if (typeof window.showInactive === 'function') window.showInactive();
      else window.show?.();
    }
  }

  function syncWindow() {
    if (disposing) return;
    if (!isVisibleNow()) {
      hideWindow();
      return;
    }
    showWindow();
  }

  function setContentSize(size) {
    const width = Math.max(MIN_OVERLAY_WIDTH, Math.round(Number(size?.width) || 0));
    const height = Math.max(MIN_OVERLAY_HEIGHT, Math.round(Number(size?.height) || 0));
    if (width === contentSize.width && height === contentSize.height) return;
    contentSize = { height, width };
    if (overlayWindow && !overlayWindow.isDestroyed?.()) {
      overlayWindow.setContentSize?.(width, height);
      positionWindow();
    }
  }

  function unregisterHotkey() {
    if (!registeredAccelerator) return;
    try {
      globalShortcut.unregister(registeredAccelerator);
    } catch (error) {
      log.warn?.('Failed to unregister overlay hotkey:', error);
    }
    registeredAccelerator = null;
  }

  function registerHotkey() {
    unregisterHotkey();
    if (suspended || settings.enabled !== true) return { ok: true, reason: 'idle' };
    const binding = settings.interactiveBinding;
    if (!binding) return { ok: true, reason: 'unassigned' };
    const { accelerator, reason } = bindingToAccelerator(binding);
    if (!accelerator) return { ok: false, reason: reason || 'unsupported-key' };
    try {
      const registered = globalShortcut.register(accelerator, toggleInteractive);
      if (!registered) return { ok: false, reason: 'register-failed' };
      registeredAccelerator = accelerator;
      return { ok: true, accelerator };
    } catch (error) {
      log.warn?.('Failed to register overlay hotkey:', error);
      return { ok: false, reason: 'register-failed' };
    }
  }

  function toggleInteractive() {
    if (!isVisibleNow()) return;
    interactive = !interactive;
    if (interactive && overlayWindow && !overlayWindow.isDestroyed?.()) {
      overlayWindow.setFocusable?.(true);
      overlayWindow.focus?.();
    }
    applyClickThrough();
    sendState();
  }

  function clearPreview() {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    previewing = false;
  }

  function startPreview() {
    clearPreview();
    previewing = true;
    interactive = true;
    syncWindow();
    registerHotkey();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      previewing = false;
      interactive = false;
      syncWindow();
    }, PREVIEW_MS);
    return { ok: true, previewMs: PREVIEW_MS, settings: getSettings() };
  }

  function setSettings(patch) {
    const source = patch && typeof patch === 'object' ? patch : {};
    const next = persistSettings({ ...settings, ...source });
    if (!next.clickThrough) interactive = true;
    registerHotkey();
    syncWindow();
    sendState();
    return next;
  }

  function setSnapshot(payload) {
    snapshot = sanitizeOverlaySnapshot(payload);
    sendState();
    return snapshot;
  }

  function setSuspended(nextSuspended) {
    suspended = nextSuspended === true;
    if (suspended) unregisterHotkey();
    else registerHotkey();
  }

  function attachMainWindow(window) {
    detachMainWindow();
    mainWindow = window;
    if (!window) return;
    const sync = () => syncWindow();
    mainListeners = [
      ['blur', sync],
      ['focus', sync],
      ['hide', sync],
      ['show', sync],
      ['closed', () => {
        if (mainWindow === window) mainWindow = null;
        disposeWindow();
      }]
    ];
    for (const [eventName, listener] of mainListeners) window.on?.(eventName, listener);
    watcher.start?.();
    registerHotkey();
    syncWindow();
  }

  function detachMainWindow() {
    if (mainWindow && mainListeners.length > 0) {
      for (const [eventName, listener] of mainListeners) {
        mainWindow.removeListener?.(eventName, listener);
      }
    }
    mainListeners = [];
    mainWindow = null;
  }

  function disposeWindow() {
    const window = overlayWindow;
    overlayWindow = null;
    interactive = false;
    if (!window || window.isDestroyed?.()) return;
    try {
      window.destroy?.();
    } catch {
      window.close?.();
    }
  }

  function addAllowedGame(exe) {
    const value = typeof exe === 'string' && exe.trim() ? exe.trim() : foreground?.exe;
    if (!value) return getSettings();
    const allowed = [...settings.allowedExecutables];
    const key = value.replace(/\//g, '\\').trim().toLowerCase();
    if (!allowed.includes(key) && !allowed.includes(fileName(key))) allowed.push(key);
    const next = setSettings({ allowedExecutables: allowed });
    if (foreground) handleForeground(foreground);
    return next;
  }

  function removeAllowedGame(exe) {
    const key = typeof exe === 'string' ? exe.replace(/\//g, '\\').trim().toLowerCase() : '';
    if (!key) return getSettings();
    const allowed = settings.allowedExecutables.filter((item) => item !== key && fileName(item) !== fileName(key));
    const next = setSettings({ allowedExecutables: allowed });
    if (foreground) handleForeground(foreground);
    return next;
  }

  function getForeground() {
    const classification = classifyCurrent();
    return {
      ...describeForeground(classification),
      title: foreground?.title || '',
      exe: classification.exe || foreground?.exe || ''
    };
  }

  function dispose() {
    disposing = true;
    clearPreview();
    unregisterHotkey();
    watcher.stop?.();
    detachMainWindow();
    disposeWindow();
  }

  function configureIpc({ ipcMain, isTrustedFrame }) {
    const assertTrustedSender = (event) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('Desktop overlay is only available for the configured Voice Room URL.');
      }
    };

    const assertOverlaySender = (event) => {
      if (!isOverlayHtmlUrl(event.senderFrame?.url || event.sender?.getURL?.() || '')) {
        throw new Error('Overlay actions are only available from the overlay window.');
      }
    };

    ipcMain.handle(GET_CHANNEL, (event) => {
      assertTrustedSender(event);
      return getSettings();
    });

    ipcMain.handle(SET_CHANNEL, (event, patch) => {
      assertTrustedSender(event);
      return setSettings(patch);
    });

    ipcMain.handle(SNAPSHOT_CHANNEL, (event, payload) => {
      assertTrustedSender(event);
      return setSnapshot(payload);
    });

    ipcMain.handle(PREVIEW_CHANNEL, (event) => {
      assertTrustedSender(event);
      return startPreview();
    });

    ipcMain.handle(READY_CHANNEL, (event) => {
      assertOverlaySender(event);
      sendState();
      return { ok: true };
    });

    ipcMain.handle(SIZE_CHANNEL, (event, size) => {
      assertOverlaySender(event);
      setContentSize(size);
      return { ok: true };
    });

    ipcMain.handle(ACTION_CHANNEL, (event, action) => {
      assertOverlaySender(event);
      return callControls.dispatch(action);
    });

    ipcMain.handle(SUSPEND_CHANNEL, (event, nextSuspended) => {
      assertTrustedSender(event);
      setSuspended(nextSuspended === true);
      return { ok: true };
    });

    ipcMain.handle(FOREGROUND_CHANNEL, (event) => {
      assertTrustedSender(event);
      return getForeground();
    });

    ipcMain.handle(ADD_GAME_CHANNEL, (event, exe) => {
      assertTrustedSender(event);
      return addAllowedGame(exe);
    });

    ipcMain.handle(REMOVE_GAME_CHANNEL, (event, exe) => {
      assertTrustedSender(event);
      return removeAllowedGame(exe);
    });
  }

  callControls.onStateChange(() => {
    if (!callControls.getState().active) {
      interactive = false;
      clearPreview();
    }
    syncWindow();
    sendState();
  });

  return {
    attachMainWindow,
    configureIpc,
    dispose,
    getSettings,
    setSettings,
    setSnapshot,
    setSuspended,
    startPreview,
    syncWindow,
    handleForeground
  };
}

module.exports = {
  ACTION_CHANNEL,
  ADD_GAME_CHANNEL,
  FOREGROUND_CHANNEL,
  GET_CHANNEL,
  PREVIEW_CHANNEL,
  PREVIEW_MS,
  READY_CHANNEL,
  REMOVE_GAME_CHANNEL,
  SET_CHANNEL,
  SIZE_CHANNEL,
  SNAPSHOT_CHANNEL,
  STATE_CHANNEL,
  SUSPEND_CHANNEL,
  createOverlayController,
  isOverlayHtmlUrl
};
