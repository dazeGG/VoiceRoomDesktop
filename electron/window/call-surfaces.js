'use strict';

const path = require('node:path');
const { describeCallControls, describeCallTooltip } = require('../call-controls');

const CALL_ICONS_DIR = path.join(__dirname, '..', '..', 'assets', 'call');
const TRAY_IN_CALL_ICON_PATH = path.join(CALL_ICONS_DIR, 'tray-in-call.png');

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
  windowLifecycle,
  dispatch,
  log = console
}) {
  const windowsWithShowListener = new WeakSet();
  const iconCache = new Map();
  let currentState = null;

  function loadIcon(icon) {
    const iconPath = resolveCallIconPath(icon, { dark: nativeTheme?.shouldUseDarkColors !== false });
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

  nativeTheme?.on?.('updated', () => {
    if (platform === 'win32' && currentState?.active) applyThumbar(windowLifecycle.getMainWindow());
  });

  return {
    apply,
    attachWindow: (window) => {
      if (platform === 'win32' && currentState) applyThumbar(window);
    }
  };
}

module.exports = {
  CALL_ICONS_DIR,
  TRAY_IN_CALL_ICON_PATH,
  buildCallMenuItems,
  buildThumbarButtons,
  createCallSurfaces,
  resolveCallIconPath
};
