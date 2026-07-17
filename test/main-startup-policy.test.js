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

test('main process installs IPC services once when macOS recreates its window', async () => {
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');
  const originalLoad = Module._load;
  const electronMock = createElectronMock();
  const appListeners = new Map();
  const handledChannels = new Set();
  let handleCalls = 0;
  let launchCalls = 0;

  electronMock.app.on = (eventName, listener) => {
    const listeners = appListeners.get(eventName) || [];
    listeners.push(listener);
    appListeners.set(eventName, listeners);
  };
  electronMock.app.whenReady = () => Promise.resolve();
  electronMock.globalShortcut = {
    register: () => true,
    setSuspended() {},
    unregister() {}
  };
  electronMock.Notification = class Notification {
    static isSupported() { return true; }
  };
  electronMock.powerMonitor = {
    on() {},
    removeListener() {},
    getSystemIdleTime: () => 0
  };
  electronMock.ipcMain = {
    handle(channel) {
      handleCalls += 1;
      if (handledChannels.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
      handledChannels.add(channel);
    },
    removeHandler() {}
  };

  Module._load = function loadWithReadyApp(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === './app/bootstrap') {
      return {
        createAppBootstrap() {
          return {
            launchApplication() {
              launchCalls += 1;
              return Promise.resolve();
            }
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(mainPath)];
    require(mainPath);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launchCalls, 1);
    assert.equal(handleCalls, 7);
    assert.deepEqual([...handledChannels].sort(), [
      'desktop-hotkeys:configure',
      'desktop-hotkeys:set-suspended',
      'desktop-idle:get-system-idle-time',
      'desktop-notifications:show',
      'window:is-fullscreen',
      'window:reload-main',
      'window:set-fullscreen'
    ]);

    const activate = appListeners.get('activate')?.[0];
    assert.equal(typeof activate, 'function');
    activate();
    activate();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launchCalls, 3);
    assert.equal(handleCalls, 7);
  } finally {
    delete require.cache[require.resolve(mainPath)];
    Module._load = originalLoad;
  }
});
