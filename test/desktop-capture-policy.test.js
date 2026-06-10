'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createScreenProfileId,
  normalizeDesktopAudioCapture,
  normalizeDesktopCapturePickerSelection,
  normalizeScreenFpsId,
  normalizeScreenQualityId
} = require('../electron/desktop-capture-policy');

const screenSource = { id: 'screen:1:0', name: 'Display 1' };
const windowSource = { id: 'window:42:0', name: 'Browser' };

const nativeSafe = {
  modes: {
    application: false,
    loopback: true,
    none: true,
    safeSystem: true
  }
};

const nativeMissing = {
  modes: {
    application: false,
    loopback: true,
    none: true,
    safeSystem: false
  }
};

describe('normalizeDesktopAudioCapture', () => {
  it('disables capture when mode is none', () => {
    assert.deepEqual(
      normalizeDesktopAudioCapture(screenSource, { mode: 'none' }, nativeSafe),
      {
        mode: 'none',
        requestedMode: 'none',
        sourceType: 'screen',
        warning: ''
      }
    );
  });

  it('uses safe-system when native helper is available', () => {
    assert.deepEqual(
      normalizeDesktopAudioCapture(windowSource, { mode: 'safe-system' }, nativeSafe),
      {
        mode: 'safe-system',
        requestedMode: 'safe-system',
        sourceType: 'window',
        warning: ''
      }
    );
  });

  it('blocks capture when safe-system is unavailable and echo fallback is disabled', () => {
    assert.deepEqual(
      normalizeDesktopAudioCapture(screenSource, {
        allowEchoFallback: false,
        mode: 'safe-system'
      }, nativeMissing),
      {
        mode: 'none',
        requestedMode: 'safe-system',
        sourceType: 'screen',
        warning: 'safe-loopback-unavailable'
      }
    );
  });

  it('falls back to loopback with warning when safe-system is unavailable', () => {
    assert.deepEqual(
      normalizeDesktopAudioCapture(screenSource, {
        allowEchoFallback: true,
        mode: 'safe-system'
      }, nativeMissing),
      {
        mode: 'loopback',
        requestedMode: 'safe-system',
        sourceType: 'screen',
        warning: 'using-echo-prone-loopback'
      }
    );
  });

  it('accepts legacy string audio options', () => {
    assert.deepEqual(
      normalizeDesktopAudioCapture(screenSource, 'loopback', nativeMissing),
      {
        mode: 'loopback',
        requestedMode: 'loopback',
        sourceType: 'screen',
        warning: ''
      }
    );
  });
});

describe('picker profile normalization', () => {
  it('falls back to default quality and fps', () => {
    assert.equal(normalizeScreenQualityId('ultra'), 'balanced');
    assert.equal(normalizeScreenFpsId('60'), '30');
  });

  it('normalizes picker selection', () => {
    assert.deepEqual(
      normalizeDesktopCapturePickerSelection({
        fpsId: '15',
        qualityId: 'high',
        sourceId: 'screen:9:0',
        streamAudioEnabled: false
      }),
      {
        fpsId: '15',
        qualityId: 'high',
        sourceId: 'screen:9:0',
        streamAudioEnabled: false
      }
    );
  });

  it('creates profile id from quality and fps', () => {
    assert.equal(createScreenProfileId('balanced', '30'), 'balanced-30');
  });
});