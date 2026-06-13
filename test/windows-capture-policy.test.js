'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  WGC_SCREEN_CAPTURER_FEATURE,
  getWindowsCaptureFeaturePolicy,
  isWindows11OrNewerRelease,
  parseWindowsBuildNumber
} = require('../electron/windows-capture-policy');

describe('windows-capture-policy', () => {
  it('parses Windows build numbers from os.release()', () => {
    assert.equal(parseWindowsBuildNumber('10.0.19045'), 19045);
    assert.equal(parseWindowsBuildNumber('10.0.22631'), 22631);
    assert.equal(parseWindowsBuildNumber(''), 0);
  });

  it('classifies Windows 11 by build number', () => {
    assert.equal(isWindows11OrNewerRelease('10.0.19045'), false);
    assert.equal(isWindows11OrNewerRelease('10.0.22000'), true);
    assert.equal(isWindows11OrNewerRelease('10.0.22631'), true);
  });

  it('disables Chromium WGC screen capturer on Windows 10 when native capture is available', () => {
    const policy = getWindowsCaptureFeaturePolicy({
      nativeCaptureAvailable: true,
      platform: 'win32',
      release: '10.0.19045'
    });

    assert.deepEqual(policy.enabledFeatures, []);
    assert.deepEqual(policy.disabledFeatures, [WGC_SCREEN_CAPTURER_FEATURE]);
    assert.equal(policy.reason, 'win10-native-helper-avoids-local-wgc-border');
  });

  it('keeps Chromium WGC screen capturer on Windows 11', () => {
    const policy = getWindowsCaptureFeaturePolicy({
      nativeCaptureAvailable: true,
      platform: 'win32',
      release: '10.0.22631'
    });

    assert.deepEqual(policy.enabledFeatures, [WGC_SCREEN_CAPTURER_FEATURE]);
    assert.deepEqual(policy.disabledFeatures, []);
    assert.equal(policy.reason, 'win11-or-newer');
  });

  it('keeps the previous WGC fallback when the native helper is missing', () => {
    const policy = getWindowsCaptureFeaturePolicy({
      nativeCaptureAvailable: false,
      platform: 'win32',
      release: '10.0.19045'
    });

    assert.deepEqual(policy.enabledFeatures, [WGC_SCREEN_CAPTURER_FEATURE]);
    assert.deepEqual(policy.disabledFeatures, []);
    assert.equal(policy.reason, 'native-helper-unavailable');
  });

  it('supports diagnostic overrides', () => {
    assert.deepEqual(
      getWindowsCaptureFeaturePolicy({ chromiumWgcOverride: '0', platform: 'win32', release: '10.0.22631' }).disabledFeatures,
      [WGC_SCREEN_CAPTURER_FEATURE]
    );
    assert.deepEqual(
      getWindowsCaptureFeaturePolicy({ chromiumWgcOverride: '1', platform: 'win32', release: '10.0.19045' }).enabledFeatures,
      [WGC_SCREEN_CAPTURER_FEATURE]
    );
  });
});
