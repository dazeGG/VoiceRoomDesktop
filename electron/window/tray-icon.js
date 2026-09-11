'use strict';

const path = require('node:path');

const WINDOWS_TRAY_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'logo', 'icon.ico');
const WINDOWS_TRAY_IN_CALL_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'call', 'tray-in-call.png');

function resolveWindowsTrayIconPath({ inCall = false } = {}) {
  return inCall ? WINDOWS_TRAY_IN_CALL_ICON_PATH : WINDOWS_TRAY_ICON_PATH;
}

module.exports = {
  WINDOWS_TRAY_IN_CALL_ICON_PATH,
  resolveWindowsTrayIconPath
};
