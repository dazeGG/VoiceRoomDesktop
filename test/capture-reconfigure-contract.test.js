'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  buildReconfigureStdinPayload,
  normalizeReconfigureCommand
} = require('../electron/native/capture-contract');

describe('normalizeReconfigureCommand', () => {
  it('accepts valid fps and maxHeight values', () => {
    assert.deepEqual(
      normalizeReconfigureCommand({ fps: 15, maxHeight: 720, type: 'reconfigure' }),
      { fps: 15, maxHeight: 720 }
    );
  });

  it('accepts partial updates', () => {
    assert.deepEqual(
      normalizeReconfigureCommand({ fps: 5, type: 'reconfigure' }),
      { fps: 5, maxHeight: null }
    );
    assert.deepEqual(
      normalizeReconfigureCommand({ maxHeight: 540, type: 'reconfigure' }),
      { fps: null, maxHeight: 540 }
    );
  });

  it('rejects invalid payloads', () => {
    assert.equal(normalizeReconfigureCommand({ fps: 0, type: 'reconfigure' }), null);
    assert.equal(normalizeReconfigureCommand({ maxHeight: 0, type: 'reconfigure' }), null);
    assert.equal(normalizeReconfigureCommand({ type: 'stop' }), null);
  });
});

describe('buildReconfigureStdinPayload', () => {
  it('merges partial commands with the active session values', () => {
    assert.deepEqual(
      buildReconfigureStdinPayload({ fps: 30, maxHeight: 1080 }, { fps: 15, maxHeight: null }),
      { cmd: 'reconfigure', fps: 15, maxHeight: 1080 }
    );
    assert.deepEqual(
      buildReconfigureStdinPayload({ fps: 30, maxHeight: 1080 }, { fps: null, maxHeight: 540 }),
      { cmd: 'reconfigure', fps: 30, maxHeight: 540 }
    );
  });
});