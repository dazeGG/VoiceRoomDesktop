'use strict';

const path = require('node:path');
const { WebContentsView } = require('electron');
const {
  TITLEBAR_HEIGHT,
  resolveTopbarBounds
} = require('../shell-theme');

const TOPBAR_HTML_PATH = path.join(__dirname, '../ui/app-topbar.html');

function installDesktopLayoutCss(webContents, desktopLayoutCss, { log } = {}) {
  const inject = () => {
    if (webContents.isDestroyed()) return;

    const url = String(webContents.getURL() || '');
    if (url.includes('renderer-recovery.html')) return;

    webContents.insertCSS(desktopLayoutCss).catch((error) => {
      log?.warn?.('Failed to inject desktop layout CSS:', error);
    });
  };

  webContents.on('did-finish-load', inject);
  webContents.on('did-navigate-in-page', inject);
}

function createAppTopbarView({ log, platform = process.platform } = {}) {
  let mainWindow = null;
  let view = null;
  let visible = true;
  const listeners = [];

  function bindWindow(window, event, handler) {
    window.on(event, handler);
    listeners.push({ window, event, handler });
  }

  function syncBounds() {
    if (!mainWindow || mainWindow.isDestroyed() || !view) return;

    const [width] = mainWindow.getContentSize();
    view.setBounds(resolveTopbarBounds({
      width,
      titlebarHeight: TITLEBAR_HEIGHT,
      visible,
      isFullscreen: mainWindow.isFullScreen()
    }));
  }

  function setMainWebFullscreenClass(isFullscreen) {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const script = isFullscreen
      ? "document.documentElement.classList.add('is-shell-fullscreen')"
      : "document.documentElement.classList.remove('is-shell-fullscreen')";

    mainWindow.webContents.executeJavaScript(script, true).catch((error) => {
      log?.warn?.('Failed to toggle shell fullscreen layout class:', error);
    });
  }

  function show() {
    visible = true;
    syncBounds();
    setMainWebFullscreenClass(false);
  }

  function hide() {
    visible = false;
    syncBounds();
    setMainWebFullscreenClass(true);
  }

  function markPlatform(webContents) {
    const platformClass = platform === 'darwin'
      ? 'is-macos'
      : platform === 'win32'
        ? 'is-windows'
        : '';

    if (!platformClass) return;

    webContents.executeJavaScript(
      `document.documentElement.classList.add(${JSON.stringify(platformClass)})`,
      true
    ).catch((error) => {
      log?.warn?.('Failed to mark app topbar platform class:', error);
    });
  }

  function attach(window) {
    mainWindow = window;
    view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    window.contentView.addChildView(view);

    view.webContents.on('did-finish-load', () => {
      markPlatform(view.webContents);
    });

    view.webContents.loadFile(TOPBAR_HTML_PATH).catch((error) => {
      log?.warn?.('Failed to load app topbar:', error);
    });

    const onBoundsChange = () => syncBounds();
    bindWindow(window, 'resize', onBoundsChange);
    bindWindow(window, 'maximize', onBoundsChange);
    bindWindow(window, 'unmaximize', onBoundsChange);
    bindWindow(window, 'enter-full-screen', () => hide());
    bindWindow(window, 'leave-full-screen', () => show());

    syncBounds();
    return view;
  }

  function destroy() {
    for (const { window, event, handler } of listeners) {
      if (!window.isDestroyed()) {
        window.removeListener(event, handler);
      }
    }
    listeners.length = 0;

    if (view && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.contentView.removeChildView(view);
      } catch {
        // Window teardown can race child-view removal.
      }
    }

    view = null;
    mainWindow = null;
  }

  return {
    attach,
    destroy,
    hide,
    show,
    syncBounds,
    getView: () => view
  };
}

module.exports = {
  TOPBAR_HTML_PATH,
  createAppTopbarView,
  installDesktopLayoutCss,
  resolveTopbarBounds
};