'use strict';

const { t } = require('../localization');

function disableWindowsApplicationMenu({ menu, platform = process.platform } = {}) {
  if (platform !== 'win32') return false;
  if (!menu || typeof menu.setApplicationMenu !== 'function') return false;

  menu.setApplicationMenu(null);
  return true;
}

function configureMacApplicationMenu({ menu, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !menu?.setApplicationMenu || !menu?.buildFromTemplate) return false;
  const item = (role, key) => ({ role, label: t(key) });
  const separator = { type: 'separator' };
  menu.setApplicationMenu(menu.buildFromTemplate([
    { label: 'VoiceRoom', submenu: [item('about', 'about'), separator, item('services', 'services'), separator,
      item('hide', 'hide'), item('hideOthers', 'hideOthers'), item('unhide', 'showAll'), separator, item('quit', 'quit')] },
    { label: t('file'), submenu: [item('close', 'close')] },
    { label: t('edit'), submenu: [item('undo', 'undo'), item('redo', 'redo'), separator,
      item('cut', 'cut'), item('copy', 'copy'), item('paste', 'paste'), item('selectAll', 'selectAll')] },
    { label: t('view'), submenu: [item('reload', 'reload'), item('forceReload', 'forceReload'), item('toggleDevTools', 'developerTools'),
      separator, item('resetZoom', 'actualSize'), item('zoomIn', 'zoomIn'), item('zoomOut', 'zoomOut'), separator, item('togglefullscreen', 'fullscreen')] },
    { label: t('window'), submenu: [item('minimize', 'minimize'), item('close', 'close'), separator, item('front', 'front')] }
  ]));
  return true;
}

module.exports = { configureMacApplicationMenu, disableWindowsApplicationMenu };
