'use strict';

const { WINDOW_BACKGROUND } = require('../shell-theme');

const ADMIN_WINDOW_TITLE = 'VoiceRoom — Админка';

/**
 * The admin app (admin.<site host>) opens in one window of its own instead of
 * the system browser, where the user is not signed in. It shares the default
 * session, so the site's session cookie carries the admin sign-in through its
 * server redirects (admin → site handoff → admin callback). It gets no preload:
 * the desktop bridge stays with the main window.
 *
 * `classifyUrl` maps a URL to 'admin', 'site' or 'external' (security/origin).
 */
function createAdminWindowController({
  BrowserWindow,
  shell,
  log = console,
  classifyUrl,
  restoreMainWindow = () => {},
  onWindowCreated = () => {}
}) {
  let adminWindow = null;

  function getWindow() {
    return adminWindow && !adminWindow.isDestroyed() ? adminWindow : null;
  }

  function isAdminWebContents(webContents) {
    const window = getWindow();
    return Boolean(window && webContents && window.webContents === webContents);
  }

  function openExternal(url) {
    shell.openExternal(url).catch((error) => {
      log.warn?.('Failed to open external URL:', url, error);
    });
  }

  function load(window, url) {
    window.loadURL(url).catch((error) => {
      log.warn?.('Failed to load the admin app:', url, error?.message || error);
    });
  }

  function createWindow() {
    const window = new BrowserWindow({
      backgroundColor: WINDOW_BACKGROUND,
      height: 820,
      minHeight: 560,
      minWidth: 800,
      title: ADMIN_WINDOW_TITLE,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      },
      width: 1280
    });
    const { webContents } = window;

    window.once('closed', () => {
      if (adminWindow === window) adminWindow = null;
    });
    // Keeps the window told apart from the main one in the taskbar.
    window.on('page-title-updated', (event) => event.preventDefault());

    webContents.setWindowOpenHandler(({ url }) => {
      if (classifyUrl(url) === 'admin') {
        load(window, url);
      } else {
        openExternal(url);
      }
      return { action: 'deny' };
    });

    // A page leaving the admin app: back to the site ("Выйти") closes this
    // window and shows the main one; anything else goes to the system browser.
    webContents.on('will-navigate', (event, url) => {
      const target = classifyUrl(url);
      if (target === 'admin') return;
      event.preventDefault();
      if (target === 'site') {
        window.close();
        restoreMainWindow();
        return;
      }
      openExternal(url);
    });

    // The sign-in redirects pass through the site; only a redirect elsewhere
    // is sent to the system browser.
    webContents.on('will-redirect', (event, url) => {
      if (classifyUrl(url) !== 'external') return;
      event.preventDefault();
      openExternal(url);
    });

    webContents.on('render-process-gone', (_event, details) => {
      log.warn?.('Admin window renderer gone:', details);
    });

    onWindowCreated(window);
    return window;
  }

  /** Opens an admin-app URL, reusing the admin window. False for any other URL. */
  function open(url) {
    if (classifyUrl(url) !== 'admin') return false;

    const existing = getWindow();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      load(existing, url);
      return true;
    }

    adminWindow = createWindow();
    load(adminWindow, url);
    return true;
  }

  function close() {
    getWindow()?.close();
  }

  return {
    close,
    getWindow,
    isAdminWebContents,
    open
  };
}

module.exports = {
  ADMIN_WINDOW_TITLE,
  createAdminWindowController
};
