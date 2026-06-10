'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { shouldRunUpdateGateState } = require('../electron/update-gate-policy');

describe('shouldRunUpdateGateState', () => {
  it('skips the gate in preview mode', () => {
    assert.equal(shouldRunUpdateGateState({ isPackaged: true, previewEnabled: true }), false);
  });

  it('skips the gate in development builds', () => {
    assert.equal(shouldRunUpdateGateState({ isPackaged: false, previewEnabled: false }), false);
  });

  it('runs the gate for packaged builds', () => {
    assert.equal(shouldRunUpdateGateState({ isPackaged: true, previewEnabled: false }), true);
  });
});