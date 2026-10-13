'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  normalizeApplyProfileRequest
} = require('../electron/policies/desktop-capture');

describe('desktop capture apply-profile normalization', () => {
  it('maps text mode to 5 fps and low quality to 540p', () => {
    assert.deepEqual(
      normalizeApplyProfileRequest({ fpsId: '5', qualityId: 'low' }),
      { fps: 5, fpsId: '5', maxHeight: 540, maxWidth: 960, qualityId: 'low' }
    );
  });

  it('maps games mode to 30 fps and balanced quality to 720p', () => {
    assert.deepEqual(
      normalizeApplyProfileRequest({ fpsId: '30', qualityId: 'balanced' }),
      { fps: 30, fpsId: '30', maxHeight: 720, maxWidth: 1280, qualityId: 'balanced' }
    );
  });

  it('caps source quality at 4K, and at 1440p for 60 fps', () => {
    assert.deepEqual(
      normalizeApplyProfileRequest({ fpsId: '5', qualityId: 'source' }),
      { fps: 5, fpsId: '5', maxHeight: 2160, maxWidth: 3840, qualityId: 'source' }
    );
    assert.deepEqual(
      normalizeApplyProfileRequest({ fpsId: '60', qualityId: 'source' }),
      { fps: 60, fpsId: '60', maxHeight: 1440, maxWidth: 2560, qualityId: 'source' }
    );
  });

  it('falls back invalid values to defaults', () => {
    assert.deepEqual(
      normalizeApplyProfileRequest({ fpsId: '99', qualityId: 'native' }),
      { fps: 30, fpsId: '30', maxHeight: 720, maxWidth: 1280, qualityId: 'balanced' }
    );
  });

  it('defaults an empty request to balanced 30fps', () => {
    assert.deepEqual(
      normalizeApplyProfileRequest(),
      { fps: 30, fpsId: '30', maxHeight: 720, maxWidth: 1280, qualityId: 'balanced' }
    );
  });
});
