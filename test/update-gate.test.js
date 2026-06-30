'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MAC_AUTO_UPDATE_ENABLED,
  shouldRunUpdateGateState
} = require('../electron/policies/update-gate-policy');

describe('shouldRunUpdateGateState', () => {
  it('skips the gate in preview mode', () => {
    assert.equal(shouldRunUpdateGateState({ isPackaged: true, previewEnabled: true }), false);
  });

  it('skips the gate in development builds', () => {
    assert.equal(shouldRunUpdateGateState({ isPackaged: false, previewEnabled: false }), false);
  });

  it('skips the gate for packaged dev builds', () => {
    assert.equal(shouldRunUpdateGateState({
      buildProfile: { channel: 'dev', buildHash: 'abc12345' },
      isPackaged: true,
      previewEnabled: false
    }), false);
  });

  it('runs the gate for packaged release builds on Windows', () => {
    assert.equal(shouldRunUpdateGateState({
      buildProfile: { channel: 'release' },
      isPackaged: true,
      platform: 'win32',
      previewEnabled: false
    }), true);
  });

  it('skips the gate for macOS while auto-update is disabled', () => {
    assert.equal(MAC_AUTO_UPDATE_ENABLED, false);
    assert.equal(shouldRunUpdateGateState({
      buildProfile: { channel: 'release' },
      isPackaged: true,
      platform: 'darwin',
      previewEnabled: false
    }), false);
  });

  it('runs the gate for macOS when auto-update is explicitly enabled', () => {
    assert.equal(shouldRunUpdateGateState({
      buildProfile: { channel: 'release' },
      isPackaged: true,
      macAutoUpdateEnabled: true,
      platform: 'darwin',
      previewEnabled: false
    }), true);
  });
});