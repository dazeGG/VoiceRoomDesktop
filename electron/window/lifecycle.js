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

    tray = new Tray(resolveTrayIconPath());
    tray.setToolTip('Voice Room');
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'Открыть Voice Room',
        click: restoreMainWindow
      },
      {
        label: 'Выход',
        click: () => {
          requestQuit();
          app.quit();
        }
      }
    ]));
    tray.on('click', restoreMainWindow);
    tray.on('double-click', restoreMainWindow);
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
    hasTray,
    installTray,
    isQuitRequested,
    requestQuit,
    restoreMainWindow,
    shouldQuitForWindowAllClosed
  };
}

module.exports = {
  createWindowLifecycleController
};
