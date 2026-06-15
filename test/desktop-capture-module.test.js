'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { it } = require('node:test');

function loadDesktopCaptureWithMocks() {
  const originalLoad = Module._load;
  const electronMock = {
    app: {
      getAppPath: () => process.cwd(),
      isPackaged: false,
      on: () => {}
    },
    BrowserWindow: {
      fromWebContents: () => null
    },
    desktopCapturer: {
      getSources: async () => []
    },
    ipcMain: {
      handle: () => {}
    },
    MessageChannelMain: class FakeMessageChannelMain {
      constructor() {
        this.port1 = {};
        this.port2 = {};
      }
    },
    shell: {
      openExternal: () => Promise.resolve()
    },
    systemPreferences: {
      askForMediaAccess: async () => true,
      getMediaAccessStatus: () => 'granted'
    },
    utilityProcess: {
      fork: () => ({
        kill: () => {},
        on: () => {},
        postMessage: () => {},
        stderr: { on: () => {} },
        stdout: { on: () => {} }
      })
    }
  };
  const logMock = {
    error: () => {},
    info: () => {},
    warn: () => {},
    transports: {
      console: {},
      file: {}
    }
  };
  const modulesToClear = [
    '../electron/desktop-capture',
    '../electron/desktop-capture/index',
    '../electron/desktop-capture/state',
    '../electron/native/audio',
    '../electron/native/capture',
    '../electron/logger',
    '../electron/security',
    '../electron/security/index',
    '../electron/security/mac',
    '../electron/security/origin'
  ].map((request) => {
    try {
      return require.resolve(request);
    } catch {
      return null;
    }
  }).filter(Boolean);

  modulesToClear.forEach((modulePath) => delete require.cache[modulePath]);
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'electron-log') return logMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../electron/desktop-capture');
  } finally {
    Module._load = originalLoad;
    modulesToClear.forEach((modulePath) => delete require.cache[modulePath]);
  }
}

it('loads the desktop-capture entrypoint and exports bootstrap handlers', () => {
  const desktopCapture = loadDesktopCaptureWithMocks();

  assert.equal(typeof desktopCapture.configureDesktopCaptureIpc, 'function');
  assert.equal(typeof desktopCapture.configureScreenPickerIpc, 'function');
  assert.equal(typeof desktopCapture.recordGrantedDesktopCapture, 'function');
  assert.equal(typeof desktopCapture.takePendingDesktopCaptureSource, 'function');
});
