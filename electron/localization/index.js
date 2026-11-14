'use strict';

const { fileURLToPath } = require('node:url');
const path = require('node:path');
const { isLocale, resolveLocale, translate } = require('./catalog');

let locale = 'ru';

function getLocale() {
  return locale;
}

function t(key, values) {
  return translate(locale, key, values);
}

function createLocaleController({ app, settingsStore, getWindows = () => [], isTrustedFrame, log = console }) {
  const listeners = new Set();
  const localPages = new Set([
    'renderer-recovery.html',
    'connection-lost.html',
    'screen-picker-preview.html',
    'update-splash.html',
    'overlay.html'
  ].map((name) => path.resolve(__dirname, '../ui', name)));

  function initialize() {
    const saved = settingsStore.read().locale;
    locale = isLocale(saved) ? saved : resolveLocale(app.getPreferredSystemLanguages?.() ?? []);
    if (!isLocale(saved)) {
      try {
        settingsStore.patch({ locale });
      } catch (error) {
        log.warn?.('Could not persist initial language:', error);
      }
    }
    return locale;
  }

  function set(next) {
    if (!isLocale(next)) throw new TypeError('Unsupported language.');
    settingsStore.patch({ locale: next });
    if (next === locale) return locale;
    locale = next;
    for (const window of getWindows()) {
      try {
        if (!window.isDestroyed?.()) window.webContents.send('locale:changed', locale);
      } catch (error) {
        log.warn?.('Could not notify a closed language surface:', error);
      }
    }
    for (const listener of listeners) {
      try {
        listener(locale);
      } catch (error) {
        log.warn?.('Could not refresh a language surface:', error);
      }
    }
    return locale;
  }

  function isTrustedLocalFrame(event) {
    if (event.senderFrame !== event.sender?.mainFrame) return false;
    try {
      return localPages.has(path.resolve(fileURLToPath(event.senderFrame.url)));
    } catch {
      return false;
    }
  }

  function configureIpc(ipcMain) {
    ipcMain.handle('locale:get', (event) => {
      if (!isTrustedFrame(event.senderFrame) && !isTrustedLocalFrame(event))
        throw new Error('Untrusted language request.');
      return locale;
    });
    ipcMain.handle('locale:set', (event, next) => {
      if (!isTrustedFrame(event.senderFrame)) throw new Error('Untrusted language request.');
      return set(next);
    });
  }

  return {
    initialize,
    set,
    get: getLocale,
    configureIpc,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

module.exports = { createLocaleController, getLocale, t };
