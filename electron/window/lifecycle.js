'use strict';

const {
  isAltF4Input,
  shouldHideToTrayOnClose,
  shouldQuitWhenAllWindowsClosed,
  shouldUseWindowsTray
} = require('./lifecycle-policy');

function createWindowLifecycleController({
  Menu,
  Tray,
  app,
  platform = process.platform,
  resolveTrayIconPath
}) {
  let mainWindow = null;
  let nextCloseIsExplicit = false;
  let quitRequested = false;
  let tray = null;
  let updateAction = null;
  let callMenu = { inCall: false, items: [], tooltip: 'Voice Room' };
  let diagnosticsActions = null;

  function attachMainWindow(window) {
    mainWindow = window;

    window.once('closed', () => {
      if (mainWindow === window) mainWindow = null;
      if (quitRequested && tray) {
        tray.destroy();
        tray = null;
      }
    });

    window.on('close', (event) => {
      const closeIsExplicit = consumeExplicitCloseRequest();
      if (closeIsExplicit) {
        quitRequested = true;
        return;
      }
      if (!shouldHideToTrayOnClose({ isExplicitQuit: quitRequested, platform })) return;
      event.preventDefault();
      window.hide();
    });

    installExplicitQuitShortcut(window);
  }

  function installTray() {
    if (!shouldUseWindowsTray(platform) || tray) return;

    tray = new Tray(resolveTrayIconPath({ inCall: callMenu.inCall }));
    tray.setToolTip(callMenu.tooltip);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', restoreMainWindow);
    tray.on('double-click', restoreMainWindow);
  }

  function buildTrayMenu() {
    const template = [
      {
        label: 'Открыть Voice Room',
        click: restoreMainWindow
      }
    ];
    if (callMenu.items.length > 0) {
      template.push({ type: 'separator' }, ...callMenu.items, { type: 'separator' });
    }
    if (updateAction) {
      template.push({ label: updateAction.label, click: updateAction.click });
    }
    if (diagnosticsActions) {
      template.push({
        label: 'Диагностика',
        submenu: [
          { label: 'Открыть папку логов', click: diagnosticsActions.openLogsFolder },
          { label: 'Скопировать информацию о системе', click: diagnosticsActions.copyInfo }
        ]
      });
    }
    template.push({
      label: 'Выход',
      click: () => {
        requestQuit();
        app.quit();
      }
    });
    return Menu.buildFromTemplate(template);
  }

  function setUpdateAction(action) {
    updateAction = action && typeof action.click === 'function'
      ? { label: String(action.label || 'Обновить и перезапустить'), click: action.click }
      : null;
    if (tray) tray.setContextMenu(buildTrayMenu());
  }

  function setCallMenu({ inCall = false, items = [], tooltip = 'Voice Room' } = {}) {
    const iconChanged = Boolean(inCall) !== callMenu.inCall;
    callMenu = { inCall: Boolean(inCall), items: Array.isArray(items) ? items : [], tooltip: String(tooltip) };
    if (!tray) return;
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(callMenu.tooltip);
    if (iconChanged) tray.setImage(resolveTrayIconPath({ inCall: callMenu.inCall }));
  }

  function setDiagnosticsActions(actions) {
    diagnosticsActions = actions
      && typeof actions.openLogsFolder === 'function'
      && typeof actions.copyInfo === 'function'
      ? { copyInfo: actions.copyInfo, openLogsFolder: actions.openLogsFolder }
      : null;
    if (tray) tray.setContextMenu(buildTrayMenu());
  }

  function getMainWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  }

  function isMainWindowVisible() {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  }

  function installExplicitQuitShortcut(window) {
    if (!shouldUseWindowsTray(platform)) return;

    window.webContents.on('before-input-event', (_event, input) => {
      if (isAltF4Input(input)) requestNextCloseQuit();
    });
  }

  function restoreMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return true;
  }

  function requestQuit() {
    quitRequested = true;
  }

  function requestNextCloseQuit() {
    nextCloseIsExplicit = true;
  }

  function consumeExplicitCloseRequest() {
    if (!nextCloseIsExplicit) return false;
    nextCloseIsExplicit = false;
    return true;
  }

  function shouldQuitForWindowAllClosed() {
    return shouldQuitWhenAllWindowsClosed({
      isExplicitQuit: quitRequested,
      platform,
      trayEnabled: Boolean(tray)
    });
  }

  function hasTray() {
    return Boolean(tray);
  }

  function isQuitRequested() {
    return quitRequested;
  }

  return {
    attachMainWindow,
    getMainWindow,
    hasTray,
    installTray,
    isMainWindowVisible,
    isQuitRequested,
    requestQuit,
    restoreMainWindow,
    setCallMenu,
    setDiagnosticsActions,
    setUpdateAction,
    shouldQuitForWindowAllClosed
  };
}

module.exports = {
  createWindowLifecycleController
};
