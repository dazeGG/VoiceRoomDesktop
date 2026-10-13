'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const { resolveWindowsTrayIconPath } = require('../electron/window/tray-icon');

const repoRoot = path.join(__dirname, '..');

describe('Windows tray icon path', () => {
  it('resolves to the packaged icon asset included by electron-builder', () => {
    assert.equal(
      resolveWindowsTrayIconPath(),
      path.join(repoRoot, 'assets', 'logo', 'icon.ico')
    );
  });

  it('follows the app icon theme, with the in-call badge in the same colour', () => {
    assert.equal(
      resolveWindowsTrayIconPath({ theme: 'graphite-ice' }),
      path.join(repoRoot, 'assets', 'logo', 'themes', 'graphite-ice.ico')
    );
    assert.equal(
      resolveWindowsTrayIconPath({ inCall: true, theme: 'graphite-coral' }),
      path.join(repoRoot, 'assets', 'call', 'tray-in-call-graphite-coral.png')
    );
    assert.equal(
      resolveWindowsTrayIconPath({ inCall: true }),
      path.join(repoRoot, 'assets', 'call', 'tray-in-call.png')
    );
  });
});
