'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

function oklchToHex(lightness, chroma, hue) {
  const a = chroma * Math.cos(hue * Math.PI / 180);
  const b = chroma * Math.sin(hue * Math.PI / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ];
  return `#${linear.map((value) => {
    const clamped = Math.min(1, Math.max(0, value));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

describe('shell theme chrome', () => {
  it('builds desktop layout css with titlebar offset and fullscreen reset', () => {
    const css = buildDesktopLayoutCss(32);

    assert.match(css, /--voice-room-shell-topbar:\s*32px/);
    assert.match(css, /padding-top:\s*var\(--voice-room-shell-topbar\)/);
    assert.match(css, /--voice-room-app-height/);
    assert.doesNotMatch(css, /\.lobby-preview-chat/);
    assert.doesNotMatch(css, /\.room-chat-rail/);
    assert.doesNotMatch(css, /\.lobby-shell/);
    assert.match(css, /is-shell-fullscreen/);
  });

  it('uses hidden titlebar and overlay on Windows', () => {
    const windows = getMainWindowChromeOptions('win32');
    const mac = getMainWindowChromeOptions('darwin');

    assert.equal(windows.titleBarStyle, 'hidden');
    assert.equal(windows.titleBarOverlay.height, TITLEBAR_HEIGHT - 1);
    assert.equal(mac.titleBarStyle, 'hidden');
    assert.equal(mac.titleBarOverlay, undefined);
  });

  it('paints the Windows caption buttons with the topbar background', () => {
    const tokens = fs.readFileSync(path.join(__dirname, '../electron/shell-tokens.css'), 'utf8');
    const [, lightness, chroma, hue] = tokens.match(/--paper:\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/);

    assert.equal(
      getMainWindowChromeOptions('win32').titleBarOverlay.color,
      oklchToHex(Number(lightness) / 100, Number(chroma), Number(hue))
    );
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