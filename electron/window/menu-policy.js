'use strict';

function disableWindowsApplicationMenu({ menu, platform = process.platform } = {}) {
  if (platform !== 'win32') return false;
  if (!menu || typeof menu.setApplicationMenu !== 'function') return false;

  menu.setApplicationMenu(null);
  return true;
}

module.exports = { disableWindowsApplicationMenu };
