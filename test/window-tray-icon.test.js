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
});
