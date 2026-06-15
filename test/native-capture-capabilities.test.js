'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const originalPlatform = process.platform;
const originalNativeCaptureEnv = process.env.VOICE_ROOM_NATIVE_CAPTURE;

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  });
}

function restoreGlobals() {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: originalPlatform
  });

  if (originalNativeCaptureEnv === undefined) {
    delete process.env.VOICE_ROOM_NATIVE_CAPTURE;
  } else {
    process.env.VOICE_ROOM_NATIVE_CAPTURE = originalNativeCaptureEnv;
  }
}

function loadNativeCapture({ appPath, version }) {
  const originalLoad = Module._load;
  const modulePath = require.resolve('../electron/native/capture');
  delete require.cache[modulePath];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getAppPath: () => appPath,
          getVersion: () => version,
          on: () => {}
        },
        MessageChannelMain: class FakeMessageChannelMain {},
        utilityProcess: {}
      };
    }

    if (request === 'electron-log') {
      return {
        error: () => {},
        info: () => {},
        warn: () => {},
        transports: { console: {}, file: {} }
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../electron/native/capture');
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

function createHelperFixture() {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-native-capture-'));
  const helperDir = path.join(appPath, 'native', 'bin', 'windows');
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(path.join(helperDir, 'ScreenCursorCapture.exe'), '');
  return appPath;
}

afterEach(() => {
  restoreGlobals();
});

describe('native capture capabilities', () => {
  it('disables Windows native capture by default for dev prerelease builds', () => {
    setPlatform('win32');
    delete process.env.VOICE_ROOM_NATIVE_CAPTURE;
    const nativeCapture = loadNativeCapture({
      appPath: createHelperFixture(),
      version: '1.1.9-dev.1'
    });

    assert.deepEqual(nativeCapture.getNativeCaptureCapabilities(), {
      available: false,
      platform: 'win32',
      reason: 'disabled-for-dev-build'
    });
  });

  it('allows explicit override to enable native capture for dev prerelease builds', () => {
    setPlatform('win32');
    process.env.VOICE_ROOM_NATIVE_CAPTURE = '1';
    const nativeCapture = loadNativeCapture({
      appPath: createHelperFixture(),
      version: '1.1.9-dev.1'
    });

    assert.deepEqual(nativeCapture.getNativeCaptureCapabilities(), {
      available: true,
      platform: 'win32',
      reason: ''
    });
  });

  it('keeps release builds enabled by default when the helper exists', () => {
    setPlatform('win32');
    delete process.env.VOICE_ROOM_NATIVE_CAPTURE;
    const nativeCapture = loadNativeCapture({
      appPath: createHelperFixture(),
      version: '1.1.9'
    });

    assert.deepEqual(nativeCapture.getNativeCaptureCapabilities(), {
      available: true,
      platform: 'win32',
      reason: ''
    });
  });

  it('preserves explicit disabled-by-env reason', () => {
    setPlatform('win32');
    process.env.VOICE_ROOM_NATIVE_CAPTURE = '0';
    const nativeCapture = loadNativeCapture({
      appPath: createHelperFixture(),
      version: '1.1.9'
    });

    assert.deepEqual(nativeCapture.getNativeCaptureCapabilities(), {
      available: false,
      platform: 'win32',
      reason: 'disabled-by-env'
    });
  });
});
