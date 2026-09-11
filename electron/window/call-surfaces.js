'use strict';

const path = require('node:path');
const { describeCallControls, describeCallTooltip } = require('../call-controls');

const CALL_ICONS_DIR = path.join(__dirname, '..', '..', 'assets', 'call');
const TRAY_IN_CALL_ICON_PATH = path.join(CALL_ICONS_DIR, 'tray-in-call.png');
const PERSONALIZE_REGISTRY_KEY = ['HKCU', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Themes', 'Personalize']
  .join(String.fromCharCode(92));

function parseSystemUsesLightTheme(output) {
  const match = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(output || ''));
  return match ? Number.parseInt(match[1], 16) !== 0 : null;
}

/**
 * The thumbnail toolbar sits on the taskbar flyout, which follows the Windows
 * system (taskbar) theme rather than the app theme Electron reports. The
 * registry is read in the background at creation and after each theme change;
 * until then, or when it fails, the taskbar counts as dark (the Windows default).
 */
function createWindowsTaskbarThemeReader({ execFile, log = console }) {
  const listeners = new Set();
  let dark = true;
  let reading = false;
  let rereadQueued = false;

  function refresh() {
    if (reading) {
      rereadQueued = true;
      return;
    }
    reading = true;
    execFile('reg', ['query', PERSONALIZE_REGISTRY_KEY, '/v', 'SystemUsesLightTheme'], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    }, (error, stdout) => {
      reading = false;
      if (error) log.warn?.('Failed to read the taskbar theme:', error?.message || error);
      const next = error ? true : parseSystemUsesLightTheme(stdout) !== true;
      const changed = next !== dark;
      dark = next;
      if (changed) {
        for (const listener of listeners) listener();
      }
      if (rereadQueued) {
        rereadQueued = false;
        refresh();
      }
    });
  }

  refresh();
  return {
    invalidate: refresh,
    isDark: () => dark,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

// Glyph colour is picked for contrast with the shell theme: light glyphs on a
// dark taskbar flyout, dark glyphs on a light one.
function resolveCallIconPath(icon, { dark = true, iconsDir = CALL_ICONS_DIR } = {}) {
  return path.join(iconsDir, `${icon}-${dark ? 'light' : 'dark'}.png`);
}

function buildCallMenuItems(state, dispatch) {
  return describeCallControls(state).map(({ action, label }) => ({
    label,
    click: () => dispatch(action)
  }));
}

function buildThumbarButtons(state, { dispatch, loadIcon }) {
  return describeCallControls(state).map(({ action, icon, label }) => ({
    click: () => dispatch(action),
    icon: loadIcon(icon),
    tooltip: label
  }));
}

/**
 * Mirrors the web call state onto the OS: tray menu, tooltip and icon plus the
 * taskbar thumbnail toolbar on Windows, the Dock menu on macOS.
 */
function createCallSurfaces({
  app,
  Menu,
  nativeImage,
  nativeTheme,
  platform = process.platform,
  taskbarTheme = {
    invalidate() {},
    isDark: () => nativeTheme?.shouldUseDarkColors !== false
  },
  windowLifecycle,
  dispatch,
  log = console
}) {
  const windowsWithShowListener = new WeakSet();
  const iconCache = new Map();
  let currentState = null;

  function loadIcon(icon) {
    const iconPath = resolveCallIconPath(icon, { dark: taskbarTheme.isDark() });
    if (!iconCache.has(iconPath)) iconCache.set(iconPath, nativeImage.createFromPath(iconPath));
    return iconCache.get(iconPath);
  }

  function applyThumbar(window) {
    if (!window || window.isDestroyed()) return;
    if (!windowsWithShowListener.has(window)) {
      windowsWithShowListener.add(window);
      // Hiding to the tray drops the taskbar button together with its toolbar.
      window.on('show', () => {
        if (currentState) applyThumbar(window);
      });
    }
    try {
      window.setThumbarButtons(buildThumbarButtons(currentState, { dispatch, loadIcon }));
    } catch (error) {
      log.warn?.('Failed to update taskbar call buttons:', error);
    }
  }

  function apply(state) {
    currentState = state;
    if (platform === 'win32') {
      windowLifecycle.setCallMenu({
        inCall: state.active,
        items: buildCallMenuItems(state, dispatch),
        tooltip: describeCallTooltip(state)
      });
      applyThumbar(windowLifecycle.getMainWindow());
      return;
    }
    if (platform === 'darwin' && app.dock) {
      app.dock.setMenu(Menu.buildFromTemplate(buildCallMenuItems(state, dispatch)));
    }
  }

  function reapplyThumbar() {
    if (platform === 'win32' && currentState?.active) applyThumbar(windowLifecycle.getMainWindow());
  }

  nativeTheme?.on?.('updated', () => {
    taskbarTheme.invalidate();
    reapplyThumbar();
  });
  taskbarTheme.subscribe?.(reapplyThumbar);

  return {
    apply,
    attachWindow: (window) => {
      if (platform === 'win32' && currentState) applyThumbar(window);
    }
  };
}

module.exports = {
  CALL_ICONS_DIR,
  PERSONALIZE_REGISTRY_KEY,
  TRAY_IN_CALL_ICON_PATH,
  buildCallMenuItems,
  buildThumbarButtons,
  createCallSurfaces,
  createWindowsTaskbarThemeReader,
  parseSystemUsesLightTheme,
  resolveCallIconPath
};
