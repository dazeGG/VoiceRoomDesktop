'use strict';

const { DEFAULT_APP_ICON_THEME, resolveAppIconPath, resolveTrayInCallIconPath } = require('../app-icon');

const WINDOWS_TRAY_ICON_PATH = resolveAppIconPath(DEFAULT_APP_ICON_THEME, { format: 'ico' });
const WINDOWS_TRAY_IN_CALL_ICON_PATH = resolveTrayInCallIconPath(DEFAULT_APP_ICON_THEME);

function resolveWindowsTrayIconPath({ inCall = false, theme = DEFAULT_APP_ICON_THEME } = {}) {
  return inCall ? resolveTrayInCallIconPath(theme) : resolveAppIconPath(theme, { format: 'ico' });
}

module.exports = {
  WINDOWS_TRAY_IN_CALL_ICON_PATH,
  WINDOWS_TRAY_ICON_PATH,
  resolveWindowsTrayIconPath
};
