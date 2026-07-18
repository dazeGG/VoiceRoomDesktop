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
        createMacScreenCaptureAccessError: (error) => error,
        getFrameScopeKey: () => '',
        isTrustedFrame: () => true,
        isTrustedOrigin: () => true,
        openMacScreenCaptureSettings: () => {}
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return {
      getPreflightChecks: () => preflightChecks,
      state: require('../electron/desktop-capture/state')
    };
  } finally {
    Module._load = originalLoad;
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
  const { getPreflightChecks, state } = loadStateWithMocks({
    getSources: async () => {
      sourceRequests += 1;
      return [source];
    }
  });

  const sources = await state.getDesktopCaptureSources();

  assert.deepEqual(sources, [source]);
  assert.equal(sourceRequests, 1);
  assert.equal(getPreflightChecks(), 0);
});
