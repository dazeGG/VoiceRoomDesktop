'use strict';

const { HIDDEN_LAUNCH_ARG } = require('./app/launch-mode');

const GET_CHANNEL = 'desktop-autostart:get-settings';
const SET_CHANNEL = 'desktop-autostart:set-settings';
const SETTINGS_FILE = 'desktop-settings.json';

function createAutostartController({
  app,
  fs,
  path,
  platform = process.platform,
  env = process.env,
  log = console
}) {
  function isSupported() {
    return app.isPackaged === true && (platform === 'win32' || platform === 'darwin');
  }

  function settingsFilePath() {
    return path.join(app.getPath('userData'), SETTINGS_FILE);
  }

  function readStoredSettings() {
    try {
      const stored = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'));
      return { startMinimized: stored?.startMinimized === true };
    } catch {
      return { startMinimized: false };
    }
  }

  function writeStoredSettings(settings) {
    const filePath = settingsFilePath();
    const tempPath = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify({ startMinimized: settings.startMinimized === true }));
    fs.renameSync(tempPath, filePath);
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

    // `openAtLogin` matches our Run entry exactly. Electron only reports an entry
    // in `launchItems` (and `executableWillLaunchAtLogin`) once it has a
    // StartupApproved value, which `setLoginItemSettings` does not write for an
    // enabled entry — so a missing approval means enabled, and an entry listed
    // as not enabled was turned off in Task Manager.
    const settings = app.getLoginItemSettings(windowsLoginItem(startMinimized));
    if (settings.openAtLogin !== true) return false;
    const executable = windowsExecutablePath().toLowerCase();
    const approval = (settings.launchItems || [])
      .find((item) => typeof item?.path === 'string' && item.path.toLowerCase() === executable);
    return approval?.enabled !== false;
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
      app.setLoginItemSettings({
        enabled: true,
        openAtLogin,
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
