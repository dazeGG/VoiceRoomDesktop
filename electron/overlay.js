'use strict';

const path = require('node:path');
const { bindingToAccelerator } = require('./hotkeys');
const { createDesktopSettingsStore } = require('./desktop-settings');
const { createForegroundWatcher } = require('./overlay-foreground');
const {
  classifyForegroundApp,
  describeForeground,
  fileName,
  isGameCandidate,
  parseForegroundPayload
} = require('./policies/overlay-games');
const {
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
// Settings poll the foreground every second; keep the watcher alive a bit longer
// than that so a throttled background tab does not flap it.
const FOREGROUND_LEASE_MS = 15_000;
const MIN_OVERLAY_WIDTH = 48;
const MIN_OVERLAY_HEIGHT = 40;
const PREVIEW_PARTICIPANTS = sanitizeOverlaySnapshot({
  participants: [
    { id: 'preview-self', name: 'Вы', self: true, speaking: true },
    { id: 'preview-friend', name: 'Участник', speaking: false }
  ]
}).participants;

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
  processPid = process.pid,
  appUrl = '',
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
  let failedAccelerator = null;
  let suspended = false;
  let contentSize = { height: 48, width: 52 };
  let disposing = false;
  let foreground = null;
  let lastCandidate = null;
  let activeGame = null;
  let watcherRunning = false;
  let foregroundLease = null;
  const watcher = createWatcher({
    appPath: typeof app.getAppPath === 'function' ? app.getAppPath() : '',
    fs,
    log,
    onChange: handleForeground,
    path: pathModule,
    platform,
    resourcesPath: process.resourcesPath || '',
    tempPath: typeof app.getPath === 'function' ? app.getPath('temp') : ''
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

  function classify(payload) {
    return classifyForegroundApp(payload, { allowedExecutables: settings.allowedExecutables });
  }

  function handleForeground(raw) {
    const payload = parseForegroundPayload(raw);
    if (!payload) return;
    const ownWindow = payload.pid === processPid;
    // The hotkey focuses the overlay itself; keep showing it over the game underneath.
    if (ownWindow && interactive) return;
    foreground = payload;
    const classification = classify(payload);
    if (!ownWindow && isGameCandidate(classification)) lastCandidate = payload;
    activeGame = classification.game
      ? { ...classification, bounds: payload.bounds, title: payload.title }
      : null;
    syncWindow();
  }

  function reclassifyForeground() {
    if (foreground) handleForeground(foreground);
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
      participants: previewing && snapshot.participants.length === 0
        ? PREVIEW_PARTICIPANTS
        : snapshot.participants,
      previewing,
      settings: {
        clickThrough: settings.clickThrough,
        opacity: settings.opacity,
        showControls: false,
        showNames: settings.showNames !== false,
        showParticipants: true
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

  // PowerShell polling is not free, so the watcher only runs during a call or
  // while the settings screen is asking which window is in front.
  function watcherWanted() {
    if (disposing) return false;
    if (foregroundLease) return true;
    return settings.enabled === true && callControls.getState().active === true;
  }

  function syncWatcher() {
    const wanted = watcherWanted();
    if (wanted === watcherRunning) return;
    watcherRunning = wanted;
    if (wanted) {
      watcher.start?.();
      return;
    }
    watcher.stop?.();
    foreground = null;
    activeGame = null;
  }

  function syncWindow() {
    if (disposing) return;
    syncWatcher();
    if (isVisibleNow()) showWindow();
    else hideWindow();
    syncHotkey();
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

  function wantedAccelerator() {
    if (suspended || !settings.interactiveBinding || !isVisibleNow()) return null;
    return bindingToAccelerator(settings.interactiveBinding).accelerator || null;
  }

  // A global shortcut steals the key from every other app, so it is held only
  // while the overlay is actually on screen.
  function syncHotkey() {
    const accelerator = wantedAccelerator();
    if (accelerator === registeredAccelerator) return;
    unregisterHotkey();
    if (!accelerator) {
      failedAccelerator = null;
      return;
    }
    if (accelerator === failedAccelerator) return;
    try {
      if (globalShortcut.register(accelerator, toggleInteractive)) {
        registeredAccelerator = accelerator;
        failedAccelerator = null;
        return;
      }
      log.warn?.('Overlay hotkey is already taken:', accelerator);
    } catch (error) {
      log.warn?.('Failed to register overlay hotkey:', error);
    }
    failedAccelerator = accelerator;
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
    syncWindow();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      previewing = false;
      syncWindow();
    }, PREVIEW_MS);
    return { ok: true, previewMs: PREVIEW_MS, settings: getSettings() };
  }

  function setSettings(patch) {
    const source = patch && typeof patch === 'object' ? patch : {};
    const next = persistSettings({ ...settings, ...source });
    syncWindow();
    sendState();
    return next;
  }

  function setSnapshot(payload) {
    snapshot = sanitizeOverlaySnapshot(payload, { baseUrl: appUrl });
    sendState();
    return snapshot;
  }

  function setSuspended(nextSuspended) {
    suspended = nextSuspended === true;
    syncHotkey();
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
    const source = typeof exe === 'string' && exe.trim() ? { exe: exe.trim() } : lastCandidate;
    const classification = classify(source);
    // Only unknown apps need the allowlist; Voice Room, browsers and launchers stay out.
    if (classification.reason !== 'not-a-game') return getSettings();
    const next = setSettings({ allowedExecutables: [...settings.allowedExecutables, classification.exe] });
    reclassifyForeground();
    return next;
  }

  function removeAllowedGame(exe) {
    const key = typeof exe === 'string' ? exe.replace(/\//g, '\\').trim().toLowerCase() : '';
    if (!key) return getSettings();
    const allowed = settings.allowedExecutables.filter((item) => item !== key && fileName(item) !== fileName(key));
    const next = setSettings({ allowedExecutables: allowed });
    reclassifyForeground();
    return next;
  }

  function leaseForeground() {
    if (foregroundLease) clearTimeout(foregroundLease);
    foregroundLease = setTimeout(() => {
      foregroundLease = null;
      syncWindow();
    }, FOREGROUND_LEASE_MS);
    foregroundLease.unref?.();
    syncWindow();
  }

  // While settings are open Voice Room itself is in front, so report the last
  // other window the user was in: that is the game they want to add.
  function getForeground() {
    leaseForeground();
    const current = foreground && foreground.pid !== processPid && isGameCandidate(classify(foreground))
      ? foreground
      : null;
    const source = current || lastCandidate;
    const classification = classify(source);
    return {
      ...describeForeground(classification),
      exe: classification.exe || '',
      title: source?.title || ''
    };
  }

  function dispose() {
    disposing = true;
    clearPreview();
    if (foregroundLease) {
      clearTimeout(foregroundLease);
      foregroundLease = null;
    }
    unregisterHotkey();
    watcher.stop?.();
    watcherRunning = false;
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
    if (!callControls.getState().active) interactive = false;
    syncWindow();
    sendState();
  });

  return {
    addAllowedGame,
    attachMainWindow,
    configureIpc,
    dispose,
    getForeground,
    getSettings,
    handleForeground,
    removeAllowedGame,
    setSettings,
    setSnapshot,
    setSuspended,
    startPreview,
    syncWindow
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
