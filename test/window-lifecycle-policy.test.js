'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  isAltF4Input,
  shouldHideToTrayOnClose,
  shouldQuitWhenAllWindowsClosed,
  shouldUseWindowsTray
} = require('../electron/window/lifecycle-policy');

describe('window lifecycle policy', () => {
  it('enables tray lifecycle only on Windows', () => {
    assert.equal(shouldUseWindowsTray('win32'), true);
    assert.equal(shouldUseWindowsTray('darwin'), false);
    assert.equal(shouldUseWindowsTray('linux'), false);
  });

  it('hides titlebar close to tray only for non-explicit Windows closes', () => {
    assert.equal(shouldHideToTrayOnClose({ platform: 'win32', isExplicitQuit: false }), true);
    assert.equal(shouldHideToTrayOnClose({ platform: 'win32', isExplicitQuit: true }), false);
    assert.equal(shouldHideToTrayOnClose({ platform: 'darwin', isExplicitQuit: false }), false);
    assert.equal(shouldHideToTrayOnClose({ platform: 'linux', isExplicitQuit: false }), false);
  });

  it('keeps the app alive after hidden Windows tray closes but quits for explicit close paths', () => {
    assert.equal(shouldQuitWhenAllWindowsClosed({
      platform: 'win32',
      trayEnabled: true,
      isExplicitQuit: false
    }), false);
    assert.equal(shouldQuitWhenAllWindowsClosed({
      platform: 'win32',
      trayEnabled: true,
      isExplicitQuit: true
    }), true);
    assert.equal(shouldQuitWhenAllWindowsClosed({
      platform: 'win32',
      trayEnabled: false,
      isExplicitQuit: false
    }), true);
  });

  it('preserves macOS window-all-closed behavior', () => {
    assert.equal(shouldQuitWhenAllWindowsClosed({
      platform: 'darwin',
      trayEnabled: false,
      isExplicitQuit: false
    }), false);
  });

  it('detects Alt+F4 as an explicit quit shortcut only on keyDown', () => {
    assert.equal(isAltF4Input({ type: 'keyDown', alt: true, key: 'F4' }), true);
    assert.equal(isAltF4Input({ type: 'keyDown', alt: true, key: 'f4' }), true);
    assert.equal(isAltF4Input({ type: 'keyUp', alt: true, key: 'F4' }), false);
    assert.equal(isAltF4Input({ type: 'keyDown', alt: false, key: 'F4' }), false);
    assert.equal(isAltF4Input({ type: 'keyDown', alt: true, key: 'F5' }), false);
  });
});
