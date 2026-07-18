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
      normalizeReconfigureCommand({ fps: 15, maxHeight: 720, maxWidth: 1280, type: 'reconfigure' }),
      { fps: 15, maxHeight: 720, maxWidth: 1280 }
    );
  });

  it('accepts the source-profile maxHeight ceiling', () => {
    assert.deepEqual(
      normalizeReconfigureCommand({ fps: 5, maxHeight: 16384, type: 'reconfigure' }),
      { fps: 5, maxHeight: 16384, maxWidth: null }
    );
  });

  it('accepts partial updates', () => {
    assert.deepEqual(
      normalizeReconfigureCommand({ fps: 5, type: 'reconfigure' }),
      { fps: 5, maxHeight: null, maxWidth: null }
    );
    assert.deepEqual(
      normalizeReconfigureCommand({ maxHeight: 540, type: 'reconfigure' }),
      { fps: null, maxHeight: 540, maxWidth: null }
    );
    assert.deepEqual(
      normalizeReconfigureCommand({ maxWidth: 960, type: 'reconfigure' }),
      { fps: null, maxHeight: null, maxWidth: 960 }
    );
  });

  it('rejects invalid payloads', () => {
    assert.equal(normalizeReconfigureCommand({ fps: 0, type: 'reconfigure' }), null);
    assert.equal(normalizeReconfigureCommand({ maxHeight: 1, maxWidth: 1, type: 'reconfigure' }), null);
    assert.equal(normalizeReconfigureCommand({ maxHeight: 0, type: 'reconfigure' }), null);
    assert.equal(normalizeReconfigureCommand({ maxWidth: 0, type: 'reconfigure' }), null);
    assert.equal(normalizeReconfigureCommand({ type: 'stop' }), null);
  });
});

describe('buildReconfigureStdinPayload', () => {
  it('merges partial commands with the active session values', () => {
    assert.deepEqual(
      buildReconfigureStdinPayload(
        { fps: 30, maxHeight: 1080, maxWidth: 1920 },
        { fps: 15, maxHeight: null, maxWidth: null }
      ),
      { cmd: 'reconfigure', fps: 15, maxHeight: 1080, maxWidth: 1920 }
    );
    assert.deepEqual(
      buildReconfigureStdinPayload(
        { fps: 30, maxHeight: 1080, maxWidth: 1920 },
        { fps: null, maxHeight: 540, maxWidth: 960 }
      ),
      { cmd: 'reconfigure', fps: 30, maxHeight: 540, maxWidth: 960 }
    );
  });
});
