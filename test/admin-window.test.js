'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ADMIN_WINDOW_TITLE, createAdminWindowController } = require('../electron/window/admin-window');
const { classifyAppUrl } = require('../electron/security/origin');

const SITE = 'https://voiceroom.ru';
const ADMIN = 'https://admin.voiceroom.ru';

function createHarness() {
  const windows = [];
  const external = [];
  const restored = [];
  const created = [];

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.calls = [];
      this.loaded = [];
      this.destroyed = false;
      this.minimized = false;
      this.handlers = new Map();
      this.webContentsHandlers = new Map();
      this.openHandler = null;
      this.webContents = {
        on: (event, handler) => this.webContentsHandlers.set(event, handler),
        setWindowOpenHandler: (handler) => {
          this.openHandler = handler;
        }
      };
      windows.push(this);
    }
    close() {
      this.calls.push('close');
      this.destroyed = true;
      const handler = this.handlers.get('closed');
      this.handlers.delete('closed');
      handler?.();
    }
    focus() { this.calls.push('focus'); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    loadURL(url) {
      this.loaded.push(url);
      return Promise.resolve();
    }
    on(event, handler) { this.handlers.set(event, handler); }
    once(event, handler) { this.handlers.set(event, handler); }
    restore() {
      this.calls.push('restore');
      this.minimized = false;
    }
    show() { this.calls.push('show'); }
    // Test helpers.
    navigate(event, url) {
      let prevented = false;
      this.webContentsHandlers.get(event)?.({ preventDefault: () => { prevented = true; } }, url);
      return prevented;
    }
  }

  const controller = createAdminWindowController({
    BrowserWindow: FakeBrowserWindow,
    classifyUrl: (url) => classifyAppUrl(url, SITE),
    log: { warn() {} },
    onWindowCreated: (window) => created.push(window),
    restoreMainWindow: () => restored.push(true),
    shell: {
      openExternal: (url) => {
        external.push(url);
        return Promise.resolve();
      }
    }
  });

  return { controller, created, external, restored, windows };
}

describe('admin window', () => {
  it('opens an admin URL in a sandboxed window with no preload', () => {
    const { controller, created, windows } = createHarness();

    assert.equal(controller.open(`${ADMIN}/accounts`), true);

    assert.equal(windows.length, 1);
    const [window] = windows;
    assert.deepEqual(window.loaded, [`${ADMIN}/accounts`]);
    assert.equal(window.options.title, ADMIN_WINDOW_TITLE);
    assert.deepEqual(window.options.webPreferences, {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
    assert.equal('preload' in window.options.webPreferences, false);
    assert.equal('partition' in window.options.webPreferences, false);
    assert.equal('session' in window.options.webPreferences, false);
    assert.deepEqual(created, [window]);
    assert.equal(controller.getWindow(), window);
  });

  it('refuses anything that is not the admin app', () => {
    const { controller, windows } = createHarness();

    assert.equal(controller.open(`${SITE}/rooms/abc`), false);
    assert.equal(controller.open('https://example.com/'), false);
    assert.equal(controller.open('https://evil.admin.voiceroom.ru/'), false);
    assert.equal(windows.length, 0);
  });

  it('reuses the one admin window, bringing it forward', () => {
    const { controller, windows } = createHarness();
    controller.open(`${ADMIN}/`);
    windows[0].minimized = true;

    assert.equal(controller.open(`${ADMIN}/reports`), true);

    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0].loaded, [`${ADMIN}/`, `${ADMIN}/reports`]);
    assert.deepEqual(windows[0].calls, ['restore', 'show', 'focus']);
  });

  it('opens a fresh window after the last one closed', () => {
    const { controller, windows } = createHarness();
    controller.open(`${ADMIN}/`);
    windows[0].close();

    assert.equal(controller.getWindow(), null);
    controller.open(`${ADMIN}/`);
    assert.equal(windows.length, 2);
  });

  it('keeps navigation inside the admin app, closes on the site, sends the rest out', () => {
    const { controller, external, restored, windows } = createHarness();
    controller.open(`${ADMIN}/`);
    const [window] = windows;

    assert.equal(window.navigate('will-navigate', `${ADMIN}/api/staff/check`), false);
    assert.equal(window.navigate('will-navigate', 'https://example.com/docs'), true);
    assert.deepEqual(external, ['https://example.com/docs']);
    assert.equal(window.isDestroyed(), false);

    // "Выйти" sends the page to the site.
    assert.equal(window.navigate('will-navigate', `${SITE}/`), true);
    assert.equal(window.isDestroyed(), true);
    assert.deepEqual(restored, [true]);
    assert.equal(controller.getWindow(), null);
    assert.deepEqual(external, ['https://example.com/docs']);
  });

  it('lets the sign-in redirects through the site and stops only outside ones', () => {
    const { controller, external, windows } = createHarness();
    controller.open(`${ADMIN}/`);
    const [window] = windows;

    assert.equal(window.navigate('will-redirect', `${SITE}/api/staff/handoff?state=s`), false);
    assert.equal(window.navigate('will-redirect', `${ADMIN}/api/staff/callback?code=c&state=s`), false);
    assert.equal(window.navigate('will-redirect', `${ADMIN}/api/staff/denied`), false);
    assert.equal(window.isDestroyed(), false);
    assert.deepEqual(external, []);

    assert.equal(window.navigate('will-redirect', 'https://example.com/'), true);
    assert.deepEqual(external, ['https://example.com/']);
  });

  it('never opens new windows from the admin app', () => {
    const { controller, external, windows } = createHarness();
    controller.open(`${ADMIN}/`);
    const [window] = windows;

    assert.deepEqual(window.openHandler({ url: `${ADMIN}/accounts/1` }), { action: 'deny' });
    assert.deepEqual(window.loaded, [`${ADMIN}/`, `${ADMIN}/accounts/1`]);
    assert.deepEqual(window.openHandler({ url: `${SITE}/rooms/abc` }), { action: 'deny' });
    assert.deepEqual(window.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
    assert.deepEqual(external, [`${SITE}/rooms/abc`, 'https://example.com/']);
    assert.equal(windows.length, 1);
  });

  it('closes on request and recognises only its own web contents', () => {
    const { controller, windows } = createHarness();
    assert.equal(controller.isAdminWebContents({}), false);
    controller.close();

    controller.open(`${ADMIN}/`);
    const [window] = windows;
    assert.equal(controller.isAdminWebContents(window.webContents), true);
    assert.equal(controller.isAdminWebContents({}), false);
    assert.equal(controller.isAdminWebContents(null), false);

    controller.close();
    assert.equal(window.isDestroyed(), true);
    assert.equal(controller.isAdminWebContents(window.webContents), false);
  });
});
