'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function createElectronMock() {
  const app = {
    commandLine: { appendSwitch() {} },
    getAppPath: () => path.join(__dirname, '..'),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on() {},
    quit() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {})
  };

  class BrowserWindow {
    static fromWebContents() { return null; }
    static getAllWindows() { return []; }
  }

  return {
    app,
    BrowserWindow,
    dialog: { showErrorBox() {} },
    ipcMain: { handle() {} },
    Menu: { setApplicationMenu() {} },
    session: {
      defaultSession: {
        setDisplayMediaRequestHandler() {},
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {}
      }
    },
    shell: { openExternal: () => Promise.resolve() },
    Tray: class Tray {}
  };
}

test('main process module load tolerates an invalid startup app URL', () => {
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');
  const originalVoiceRoomUrl = process.env.VOICE_ROOM_URL;
  const originalLoad = Module._load;
  const electronMock = createElectronMock();

  process.env.VOICE_ROOM_URL = 'not a valid url';
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(mainPath)];

    assert.doesNotThrow(() => require(mainPath));
  } finally {
    delete require.cache[require.resolve(mainPath)];
    Module._load = originalLoad;
    if (originalVoiceRoomUrl === undefined) {
      delete process.env.VOICE_ROOM_URL;
    } else {
      process.env.VOICE_ROOM_URL = originalVoiceRoomUrl;
    }
  }
});

test('main process wires window bootstrap installers into app bootstrap', () => {
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');
  const originalLoad = Module._load;
  const electronMock = createElectronMock();
  let capturedOptions;

  Module._load = function loadWithBootstrapCapture(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === './app/bootstrap') {
      return {
        createAppBootstrap(options) {
          capturedOptions = options;
          return {
            launchApplication: () => Promise.resolve()
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(mainPath)];

    assert.doesNotThrow(() => require(mainPath));
    assert.equal(typeof capturedOptions.installMediaDeviceFilter, 'function');
    assert.equal(typeof capturedOptions.installNativeCaptureBridge, 'function');
    assert.equal(typeof capturedOptions.installBuildLabel, 'function');
    assert.equal(typeof capturedOptions.showRendererRecovery, 'function');
  } finally {
    delete require.cache[require.resolve(mainPath)];
    Module._load = originalLoad;
  }
});
