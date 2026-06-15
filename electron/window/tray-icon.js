'use strict';

const path = require('node:path');

const WINDOWS_TRAY_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'logo', 'icon.ico');

function resolveWindowsTrayIconPath() {
  return WINDOWS_TRAY_ICON_PATH;
}

module.exports = {
  resolveWindowsTrayIconPath
};
