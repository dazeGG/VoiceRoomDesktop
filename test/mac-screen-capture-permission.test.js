'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { afterEach, it } = require('node:test');

const stateModulePath = require.resolve('../electron/desktop-capture/state');

afterEach(() => {
  delete require.cache[stateModulePath];
});

function loadStateWithMocks({ getSources, screenStatus = 'denied' }) {
  const originalLoad = Module._load;
  let accessErrors = 0;
  const accessError = new Error('macOS screen capture access required');
  const accessErrorCauses = [];
  let openSettingsRequests = 0;
  let preflightChecks = 0;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        BrowserWindow: { getAllWindows: () => [] },
        desktopCapturer: { getSources }
      };
    }
    if (request === '../native/audio') {
      return { getNativeAudioCapabilities: () => ({}) };
    }
    if (request === '../security') {
      return {
        assertMacScreenCaptureAccess: () => {
          preflightChecks += 1;
          throw new Error(`stale screen status: ${screenStatus}`);
        },
        createMacScreenCaptureAccessError: (error) => {
          accessErrors += 1;
          accessErrorCauses.push(error);
          return accessError;
        },
        getFrameScopeKey: () => '',
        isTrustedFrame: () => true,
        isTrustedOrigin: () => true,
        openMacScreenCaptureSettings: () => {
          openSettingsRequests += 1;
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return {
      accessError,
      getAccessErrorCauses: () => accessErrorCauses,
      getAccessErrors: () => accessErrors,
      getOpenSettingsRequests: () => openSettingsRequests,
      getPreflightChecks: () => preflightChecks,
      state: require('../electron/desktop-capture/state')
    };
  } finally {
    Module._load = originalLoad;
  }
}

async function withPlatform(platform, callback) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    ...platformDescriptor,
    value: platform
  });

  try {
    return await callback();
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
}

it('asks macOS for capture sources even when a cached permission status is denied', async () => {
  let sourceRequests = 0;
  const source = {
    appIcon: null,
    id: 'screen:0:0',
    name: 'Built-in Display',
    thumbnail: null
  };
  const {
    getAccessErrors,
    getOpenSettingsRequests,
    getPreflightChecks,
    state
  } = loadStateWithMocks({
    getSources: async () => {
      sourceRequests += 1;
      return [source];
    }
  });

  const sources = await withPlatform('darwin', () => state.getDesktopCaptureSources());

  assert.deepEqual(sources, [source]);
  assert.equal(sourceRequests, 1);
  assert.equal(getAccessErrors(), 0);
  assert.equal(getOpenSettingsRequests(), 0);
  assert.equal(getPreflightChecks(), 0);
});

it('opens macOS Screen Recording settings when capture sources resolve empty', async () => {
  let sourceRequests = 0;
  const {
    accessError,
    getAccessErrorCauses,
    getAccessErrors,
    getOpenSettingsRequests,
    getPreflightChecks,
    state
  } = loadStateWithMocks({
    getSources: async () => {
      sourceRequests += 1;
      return [];
    }
  });

  await assert.rejects(
    () => withPlatform('darwin', () => state.getDesktopCaptureSources()),
    (error) => error === accessError
  );

  assert.equal(sourceRequests, 1);
  assert.equal(getOpenSettingsRequests(), 1);
  assert.equal(getAccessErrors(), 1);
  assert.deepEqual(getAccessErrorCauses(), [undefined]);
  assert.equal(getPreflightChecks(), 0);
});

it('keeps macOS capture source rejection handling', async () => {
  const getSourcesError = new Error('Screen capture failed');
  const {
    accessError,
    getAccessErrorCauses,
    getAccessErrors,
    getOpenSettingsRequests,
    getPreflightChecks,
    state
  } = loadStateWithMocks({
    getSources: async () => {
      throw getSourcesError;
    }
  });

  await assert.rejects(
    () => withPlatform('darwin', () => state.getDesktopCaptureSources()),
    (error) => error === accessError
  );

  assert.equal(getOpenSettingsRequests(), 1);
  assert.equal(getAccessErrors(), 1);
  assert.deepEqual(getAccessErrorCauses(), [getSourcesError]);
  assert.equal(getPreflightChecks(), 0);
});
