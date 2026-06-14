'use strict';

const WINDOWS_11_MIN_BUILD = 22000;
const WGC_SCREEN_CAPTURER_FEATURE = 'WebRtcAllowWgcScreenCapturer';

function parseWindowsBuildNumber(release = '') {
  const parts = String(release || '').split('.');
  const build = Number.parseInt(parts[2] || '', 10);
  return Number.isFinite(build) ? build : 0;
}

function isWindows11OrNewerRelease(release = '') {
  return parseWindowsBuildNumber(release) >= WINDOWS_11_MIN_BUILD;
}

function normalizeWgcOverride(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) return 'enable';
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) return 'disable';
  return '';
}

function getWindowsCaptureFeaturePolicy(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return {
      disabledFeatures: [],
      enabledFeatures: [],
      reason: 'platform-unsupported'
    };
  }

  const override = normalizeWgcOverride(options.chromiumWgcOverride);
  if (override === 'enable') {
    return {
      disabledFeatures: [],
      enabledFeatures: [WGC_SCREEN_CAPTURER_FEATURE],
      reason: 'override-enabled'
    };
  }
  if (override === 'disable') {
    return {
      disabledFeatures: [WGC_SCREEN_CAPTURER_FEATURE],
      enabledFeatures: [],
      reason: 'override-disabled'
    };
  }

  const release = options.release || '';
  const nativeCaptureAvailable = Boolean(options.nativeCaptureAvailable);

  // On Windows 10, the temporary Chromium getDisplayMedia video grant can keep
  // WGC's local yellow capture border visible even though the stream is later
  // replaced with border-free native DXGI frames. If the native helper is
  // available, prefer Chromium's legacy screen capturer only for that temporary
  // grant. Windows 11 is left on WGC because it can honor the borderless path;
  // when the native helper is missing, keep the previous WGC fallback behavior.
  if (!isWindows11OrNewerRelease(release) && nativeCaptureAvailable) {
    return {
      disabledFeatures: [WGC_SCREEN_CAPTURER_FEATURE],
      enabledFeatures: [],
      reason: 'win10-native-helper-avoids-local-wgc-border'
    };
  }

  return {
    disabledFeatures: [],
    enabledFeatures: [WGC_SCREEN_CAPTURER_FEATURE],
    reason: isWindows11OrNewerRelease(release) ? 'win11-or-newer' : 'native-helper-unavailable'
  };
}

module.exports = {
  WGC_SCREEN_CAPTURER_FEATURE,
  getWindowsCaptureFeaturePolicy,
  isWindows11OrNewerRelease,
  parseWindowsBuildNumber
};
