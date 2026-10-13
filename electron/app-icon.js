'use strict';

const path = require('node:path');

const GET_CHANNEL = 'desktop-app-icon:get';
const SET_CHANNEL = 'desktop-app-icon:set-theme';
const SETTINGS_KEY = 'appIconTheme';

// The ids are the web app's colour themes (apps/web theme.svelte.ts). The
// default theme keeps the icon the installer and the executable carry; the
// others are rendered from icon.svg with their accent by `npm run icons:call`.
const DEFAULT_APP_ICON_THEME = 'graphite-volt';
const DEFAULT_ACCENT = '#c1f100';
const APP_ICON_THEMES = {
  'graphite-volt': { accent: DEFAULT_ACCENT },
  'graphite-ice': { accent: '#3fd6ff' },
  'graphite-coral': { accent: '#ff7a59' }
};

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

function normalizeAppIconTheme(value) {
  return typeof value === 'string' && Object.hasOwn(APP_ICON_THEMES, value) ? value : null;
}

function resolveAppIconPath(theme, { format = 'png' } = {}) {
  const id = normalizeAppIconTheme(theme) || DEFAULT_APP_ICON_THEME;
  if (id === DEFAULT_APP_ICON_THEME) return path.join(ASSETS_DIR, 'logo', `icon.${format}`);
  return path.join(ASSETS_DIR, 'logo', 'themes', `${id}.${format}`);
}

function resolveTrayInCallIconPath(theme) {
  const id = normalizeAppIconTheme(theme) || DEFAULT_APP_ICON_THEME;
  if (id === DEFAULT_APP_ICON_THEME) return path.join(ASSETS_DIR, 'call', 'tray-in-call.png');
  return path.join(ASSETS_DIR, 'call', `tray-in-call-${id}.png`);
}

/**
 * Mirrors the web colour theme onto the app icon: the window / taskbar button
 * on Windows, the Dock icon on macOS and the Windows tray icon. The executable
 * and installer icons are baked in at build time and stay the default.
 *
 * The web app is the source of truth and reports its theme on every start and
 * change; the last reported theme is stored so the next launch already shows it
 * before the web app has loaded.
 */
function createAppIconController({
  app,
  nativeImage,
  platform = process.platform,
  settingsStore,
  log = console,
  getMainWindow = () => null,
  refreshTray = () => {}
}) {
  function isSupported() {
    return platform === 'win32' || platform === 'darwin';
  }

  function getTheme() {
    return normalizeAppIconTheme(settingsStore.read()[SETTINGS_KEY]) || DEFAULT_APP_ICON_THEME;
  }

  function getState() {
    return { supported: isSupported(), theme: getTheme() };
  }

  function loadImage(theme, format) {
    const image = nativeImage.createFromPath(resolveAppIconPath(theme, { format }));
    return image.isEmpty?.() ? null : image;
  }

  function applyToWindow(window, theme) {
    if (platform !== 'win32' || !window || window.isDestroyed?.()) return;
    const image = loadImage(theme, 'ico');
    if (image) window.setIcon(image);
  }

  function applyToDock(theme) {
    if (platform !== 'darwin' || !app.dock) return;
    const image = loadImage(theme, 'png');
    if (image) app.dock.setIcon(image);
  }

  function apply(theme) {
    try {
      applyToWindow(getMainWindow(), theme);
      applyToDock(theme);
      refreshTray();
    } catch (error) {
      log.warn?.('Failed to apply the app icon:', error);
    }
  }

  // A window created after the web app reported a non-default theme (a relaunch
  // from the Dock or the tray) gets the stored icon right away.
  function attachWindow(window) {
    if (!isSupported()) return;
    const theme = getTheme();
    if (theme === DEFAULT_APP_ICON_THEME) return;
    applyToWindow(window, theme);
    applyToDock(theme);
  }

  function setTheme(value) {
    const theme = normalizeAppIconTheme(value);
    if (!theme) return { ...getState(), reason: 'unknown-theme' };
    if (!isSupported()) return { ...getState(), reason: 'unsupported' };

    const changed = theme !== getTheme();
    try {
      settingsStore.patch({ [SETTINGS_KEY]: theme });
    } catch (error) {
      log.warn?.('Failed to store the app icon theme:', error);
    }
    // The icon is applied even when the stored value already matches: a window
    // opened since may still carry the default one.
    if (changed || theme !== DEFAULT_APP_ICON_THEME) apply(theme);
    return { supported: true, theme };
  }

  function configureIpc({ ipcMain, isTrustedFrame }) {
    const assertTrustedSender = (event) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('The app icon is only available for the configured Voice Room URL.');
      }
    };

    ipcMain.handle(GET_CHANNEL, (event) => {
      assertTrustedSender(event);
      return getState();
    });

    ipcMain.handle(SET_CHANNEL, (event, theme) => {
      assertTrustedSender(event);
      return setTheme(theme);
    });
  }

  return {
    attachWindow,
    configureIpc,
    getState,
    getTheme,
    setTheme
  };
}

module.exports = {
  APP_ICON_THEMES,
  DEFAULT_ACCENT,
  DEFAULT_APP_ICON_THEME,
  GET_CHANNEL,
  SETTINGS_KEY,
  SET_CHANNEL,
  createAppIconController,
  normalizeAppIconTheme,
  resolveAppIconPath,
  resolveTrayInCallIconPath
};
