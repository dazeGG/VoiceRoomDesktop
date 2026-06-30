'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  TITLEBAR_HEIGHT,
  buildDesktopLayoutCss,
  getMainWindowChromeOptions,
  resolveTopbarBounds
} = require('../electron/shell-theme');
const {
  resolveTopbarBounds: resolveTopbarBoundsFromView
} = require('../electron/window/app-topbar-view');

describe('shell theme chrome', () => {
  it('builds desktop layout css with titlebar offset and fullscreen reset', () => {
    const css = buildDesktopLayoutCss(32);

    assert.match(css, /--voice-room-shell-topbar:\s*32px/);
    assert.match(css, /padding-top:\s*var\(--voice-room-shell-topbar\)/);
    assert.match(css, /\.lobby-shell/);
    assert.match(css, /is-shell-fullscreen/);
  });

  it('uses hidden titlebar and overlay on Windows', () => {
    const windows = getMainWindowChromeOptions('win32');
    const mac = getMainWindowChromeOptions('darwin');

    assert.equal(windows.titleBarStyle, 'hidden');
    assert.equal(windows.titleBarOverlay.height, TITLEBAR_HEIGHT);
    assert.equal(mac.titleBarStyle, 'hidden');
    assert.equal(mac.titleBarOverlay, undefined);
  });
});

describe('app topbar bounds', () => {
  it('fills the top strip in normal mode', () => {
    assert.deepEqual(resolveTopbarBounds({
      width: 1180,
      visible: true,
      isFullscreen: false
    }), {
      x: 0,
      y: 0,
      width: 1180,
      height: TITLEBAR_HEIGHT
    });
  });

  it('collapses the topbar in fullscreen or when hidden', () => {
    assert.deepEqual(resolveTopbarBounds({
      width: 900,
      visible: false,
      isFullscreen: false
    }), {
      x: 0,
      y: 0,
      width: 900,
      height: 0
    });

    assert.deepEqual(resolveTopbarBounds({
      width: 900,
      visible: true,
      isFullscreen: true
    }), {
      x: 0,
      y: 0,
      width: 900,
      height: 0
    });
  });

  it('re-exports resolveTopbarBounds from the view module', () => {
    assert.equal(resolveTopbarBoundsFromView, resolveTopbarBounds);
  });
});