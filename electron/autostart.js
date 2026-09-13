'use strict';

const { HIDDEN_LAUNCH_ARG } = require('./app/launch-mode');
const { SETTINGS_FILE, createDesktopSettingsStore } = require('./desktop-settings');

const GET_CHANNEL = 'desktop-autostart:get-settings';
const SET_CHANNEL = 'desktop-autostart:set-settings';

function createAutostartController({
  app,
  fs,
  path,
  platform = process.platform,
  env = process.env,
  log = console
}) {
  const settingsStore = createDesktopSettingsStore({ app, fs, log, path });

  function isSupported() {
    return app.isPackaged === true && (platform === 'win32' || platform === 'darwin');
  }

  function readStoredSettings() {
    return { startMinimized: settingsStore.read().startMinimized === true };
  }

  function writeStoredSettings(settings) {
    settingsStore.patch({ startMinimized: settings.startMinimized === true });
  }

  // The portable build runs from a temporary extraction directory; the login
  // item must point at the original portable executable instead.
  function windowsExecutablePath() {
    return env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  }

  function windowsLoginItem(startMinimized) {
    return {
      path: windowsExecutablePath(),
      args: startMinimized ? [HIDDEN_LAUNCH_ARG] : []
    };
  }

  function readOpenAtLogin(startMinimized) {
    if (platform !== 'win32') {
      return app.getLoginItemSettings().openAtLogin === true;
    }

    // Electron matches Run entries by parsing `path` as a command line, so an
    // unquoted path with a space ("…\Voice Room.exe") never matches and
    // `launchItems` comes back empty. It strips surrounding quotes before
    // comparing `openAtLogin`, so the quoted path serves both: `openAtLogin`
    // matches our Run entry (path and args), `launchItems` carries its Task
    // Manager enabled state.
    const executable = windowsExecutablePath();
    const settings = app.getLoginItemSettings({
      ...windowsLoginItem(startMinimized),
      path: `"${executable}"`
    });
    if (settings.openAtLogin !== true) return false;
    const entry = (settings.launchItems || [])
      .find((item) => typeof item?.path === 'string' && item.path.toLowerCase() === executable.toLowerCase());
    return entry?.enabled !== false;
  }

  function getSettings() {
    const { startMinimized } = readStoredSettings();
    if (!isSupported()) {
      return { openAtLogin: false, reason: 'unsupported', startMinimized, supported: false };
    }

    try {
      return { openAtLogin: readOpenAtLogin(startMinimized), startMinimized, supported: true };
    } catch (error) {
      log.warn?.('Failed to read login item settings:', error);
      return { openAtLogin: false, reason: 'read-failed', startMinimized, supported: true };
    }
  }

  function applyLoginItem(openAtLogin, startMinimized) {
    if (platform === 'win32') {
      // Turning autostart off keeps the Run entry and marks it disabled, the
      // same state Task Manager writes, so the app switch and Task Manager
      // control one startup entry. The uninstaller removes it.
      app.setLoginItemSettings({
        enabled: openAtLogin,
        openAtLogin: true,
        ...windowsLoginItem(startMinimized)
      });
      return;
    }
    app.setLoginItemSettings({ openAtLogin });
  }

  function setSettings(patch = {}) {
    const current = getSettings();
    if (!current.supported) return current;

    const source = patch && typeof patch === 'object' ? patch : {};
    const openAtLogin = typeof source.openAtLogin === 'boolean' ? source.openAtLogin : current.openAtLogin;
    const startMinimized = typeof source.startMinimized === 'boolean'
      ? source.startMinimized
      : current.startMinimized;

    try {
      writeStoredSettings({ startMinimized });
      // Windows stores the hidden-launch flag inside the Run entry itself, so a
      // changed preference re-registers the entry while autostart stays on.
      const hiddenArgChanged = platform === 'win32' && openAtLogin && startMinimized !== current.startMinimized;
      if (openAtLogin !== current.openAtLogin || hiddenArgChanged) {
        applyLoginItem(openAtLogin, startMinimized);
      }
    } catch (error) {
      log.warn?.('Failed to update login item settings:', error);
      return { ...getSettings(), reason: 'write-failed' };
    }

    return getSettings();
  }

  function configureIpc({ ipcMain, isTrustedFrame }) {
    const assertTrustedSender = (event) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('Desktop autostart is only available for the configured Voice Room URL.');
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
  }

  return {
    configureIpc,
    getSettings,
    readStoredSettings,
    setSettings
  };
}

module.exports = {
  GET_CHANNEL,
  SETTINGS_FILE,
  SET_CHANNEL,
  createAutostartController
};
