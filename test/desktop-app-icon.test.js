'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  APP_ICON_THEMES,
  DEFAULT_APP_ICON_THEME,
  GET_CHANNEL,
  SET_CHANNEL,
  createAppIconController,
  normalizeAppIconTheme,
  resolveAppIconPath,
  resolveTrayInCallIconPath
} = require('../electron/app-icon');

function createHarness({ platform = 'win32', stored, windowDestroyed = false, emptyImages = false } = {}) {
  const store = { appIconTheme: stored };
  const calls = [];
  const window = {
    isDestroyed: () => windowDestroyed,
    setIcon: (image) => calls.push(['window', image.path])
  };
  const app = { dock: { setIcon: (image) => calls.push(['dock', image.path]) } };
  const controller = createAppIconController({
    app,
    getMainWindow: () => window,
    nativeImage: {
      createFromPath: (imagePath) => ({ isEmpty: () => emptyImages, path: imagePath })
    },
    platform,
    refreshTray: () => calls.push(['tray']),
    settingsStore: {
      patch: (partial) => Object.assign(store, partial),
      read: () => store
    }
  });
  return { calls, controller, store, window };
}

function iconFile(theme, format) {
  return path.basename(resolveAppIconPath(theme, { format }));
}

describe('app icon themes', () => {
  it('knows the web colour themes and falls back to the default', () => {
    assert.deepEqual(Object.keys(APP_ICON_THEMES), ['graphite-volt', 'graphite-ice', 'graphite-coral']);
    assert.equal(normalizeAppIconTheme('graphite-ice'), 'graphite-ice');
    assert.equal(normalizeAppIconTheme('hot-pink'), null);
    assert.equal(normalizeAppIconTheme('toString'), null);
    assert.equal(normalizeAppIconTheme(undefined), null);
  });

  it('ships every icon file a theme resolves to', () => {
    for (const theme of Object.keys(APP_ICON_THEMES)) {
      for (const format of ['ico', 'png']) {
        assert.ok(fs.existsSync(resolveAppIconPath(theme, { format })), `${theme}.${format}`);
      }
      assert.ok(fs.existsSync(resolveTrayInCallIconPath(theme)), `${theme} tray in call`);
      assert.ok(fs.existsSync(resolveTrayInCallIconPath(theme).replace('.png', '@2x.png')), `${theme} tray @2x`);
    }
  });

  it('keeps the installed icon for the default theme', () => {
    assert.equal(iconFile(DEFAULT_APP_ICON_THEME, 'ico'), 'icon.ico');
    assert.equal(iconFile('unknown', 'png'), 'icon.png');
    assert.equal(iconFile('graphite-coral', 'ico'), 'graphite-coral.ico');
    assert.equal(path.basename(resolveTrayInCallIconPath('graphite-ice')), 'tray-in-call-graphite-ice.png');
  });
});

describe('app icon controller', () => {
  it('defaults to the installed icon and ignores a stored unknown theme', () => {
    assert.deepEqual(createHarness().controller.getState(), { supported: true, theme: 'graphite-volt' });
    assert.equal(createHarness({ stored: 'nope' }).controller.getTheme(), 'graphite-volt');
  });

  it('applies a reported theme to the window and the tray on Windows and stores it', () => {
    const { calls, controller, store } = createHarness();

    assert.deepEqual(controller.setTheme('graphite-ice'), { supported: true, theme: 'graphite-ice' });

    assert.equal(store.appIconTheme, 'graphite-ice');
    assert.deepEqual(calls.map(([kind]) => kind), ['window', 'tray']);
    assert.equal(path.basename(calls[0][1]), 'graphite-ice.ico');
  });

  it('applies a reported theme to the Dock on macOS', () => {
    const { calls, controller } = createHarness({ platform: 'darwin' });

    controller.setTheme('graphite-coral');

    assert.deepEqual(calls.map(([kind]) => kind), ['dock', 'tray']);
    assert.equal(path.basename(calls[0][1]), 'graphite-coral.png');
  });

  it('switches back to the default icon', () => {
    const { calls, controller } = createHarness({ stored: 'graphite-ice' });

    controller.setTheme('graphite-volt');

    assert.equal(path.basename(calls[0][1]), 'icon.ico');
  });

  it('does nothing when the default theme is reported again', () => {
    const { calls, controller } = createHarness();

    assert.deepEqual(controller.setTheme('graphite-volt'), { supported: true, theme: 'graphite-volt' });

    assert.deepEqual(calls, []);
  });

  it('refuses unknown themes without touching the icon', () => {
    const { calls, controller, store } = createHarness();
    const refused = { reason: 'unknown-theme', supported: true, theme: 'graphite-volt' };

    assert.deepEqual(controller.setTheme('hot-pink'), refused);
    assert.deepEqual(controller.setTheme({ theme: 'graphite-ice' }), refused);

    assert.deepEqual(calls, []);
    assert.equal(store.appIconTheme, undefined);
  });

  it('reports an unsupported platform instead of changing icons', () => {
    const { calls, controller } = createHarness({ platform: 'linux' });

    assert.deepEqual(controller.setTheme('graphite-ice'), {
      reason: 'unsupported',
      supported: false,
      theme: 'graphite-volt'
    });

    assert.deepEqual(calls, []);
  });

  it('puts the stored theme on a window created later and leaves the default alone', () => {
    const stored = createHarness({ stored: 'graphite-coral' });
    stored.controller.attachWindow(stored.window);
    assert.equal(path.basename(stored.calls[0][1]), 'graphite-coral.ico');

    const fresh = createHarness();
    fresh.controller.attachWindow(fresh.window);
    assert.deepEqual(fresh.calls, []);
  });

  it('keeps the answer intact when an icon file cannot be loaded', () => {
    const { calls, controller } = createHarness({ emptyImages: true });

    assert.deepEqual(controller.setTheme('graphite-ice'), { supported: true, theme: 'graphite-ice' });

    assert.deepEqual(calls, [['tray']]);
  });

  it('skips a destroyed window', () => {
    const { calls, controller } = createHarness({ windowDestroyed: true });

    controller.setTheme('graphite-ice');

    assert.deepEqual(calls, [['tray']]);
  });

  it('serves the bridge channels to the trusted frame only', () => {
    const { controller } = createHarness();
    const handlers = new Map();
    controller.configureIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      isTrustedFrame: (frame) => frame === 'trusted'
    });

    assert.deepEqual(handlers.get(GET_CHANNEL)({ senderFrame: 'trusted' }), { supported: true, theme: 'graphite-volt' });
    assert.deepEqual(handlers.get(SET_CHANNEL)({ senderFrame: 'trusted' }, 'graphite-ice'), {
      supported: true,
      theme: 'graphite-ice'
    });
    assert.throws(() => handlers.get(SET_CHANNEL)({ senderFrame: 'other' }, 'graphite-coral'), /configured Voice Room URL/);
    assert.equal(controller.getTheme(), 'graphite-ice');
  });
});
