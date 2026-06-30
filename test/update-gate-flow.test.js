'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const { describe, it } = require('node:test');

function loadUpdateGateWithMocks() {
  const handlers = new Map();
  const windows = [];

  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.closed = false;
      this.visible = false;
      this.sentStates = [];
      this.webContents = {
        send: (_channel, payload) => {
          this.sentStates.push(payload);
        }
      };
      windows.push(this);
    }

    close() {
      this.closed = true;
    }

    isDestroyed() {
      return this.closed;
    }

    loadFile() {
      queueMicrotask(() => this.emit('ready-to-show'));
      return Promise.resolve();
    }

    setMenuBarVisibility() {}

    show() {
      this.visible = true;
    }
  }

  const electronMock = {
    app: {
      getAppPath: () => '',
      isPackaged: true,
      quit: () => {}
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      }
    }
  };

  const logMock = {
    error: () => {},
    info: () => {},
    warn: () => {},
    transports: { console: {}, file: {} }
  };

  const updateGatePolicyPath = require.resolve('../electron/policies/update-gate-policy');
  const updateGatePolicyMock = {
    MAC_AUTO_UPDATE_ENABLED: false,
    readBuildProfile: () => null,
    shouldRunUpdateGateState: () => true
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'electron-log') return logMock;
    if (request === updateGatePolicyPath || request === './update-gate-policy') {
      return updateGatePolicyMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const updateGatePath = require.resolve('../electron/policies/update-gate');
  const loggerPath = require.resolve('../electron/logger');
  delete require.cache[updateGatePath];
  delete require.cache[updateGatePolicyPath];
  delete require.cache[loggerPath];

  try {
    return {
      ...require('../electron/policies/update-gate'),
      handlers,
      restore: () => {
        Module._load = originalLoad;
        delete require.cache[updateGatePath];
        delete require.cache[updateGatePolicyPath];
        delete require.cache[loggerPath];
      },
      windows
    };
  } catch (error) {
    Module._load = originalLoad;
    throw error;
  }
}

function createAutoUpdater({ checkError = null, downloadError = null } = {}) {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    if (checkError) throw checkError;
    updater.emit('update-not-available');
  };
  updater.downloadUpdate = async () => {
    if (downloadError) throw downloadError;
    updater.emit('update-downloaded');
  };
  updater.quitAndInstallCalls = [];
  updater.quitAndInstall = (...args) => {
    updater.quitAndInstallCalls.push(args);
  };
  return updater;
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('runUpdateGate updater failure flow', () => {
  it('shows update error and waits for explicit proceed when updater fails and site is available', async () => {
    const gate = loadUpdateGateWithMocks();
    try {
      const updater = createAutoUpdater({ checkError: new Error('offline updater') });
      const resultPromise = gate.runUpdateGate({
        appUrl: 'https://voiceroom.example',
        autoUpdater: updater,
        checkSiteAvailability: async () => true
      });

      await flush();
      const splash = gate.windows[0];
      assert.equal(splash.visible, true);
      assert.equal(splash.closed, false);
      assert.deepEqual(
        splash.sentStates.map((state) => [state.phase, state.canProceed]),
        [
          ['checking', undefined],
          ['update-error', false],
          ['update-error', true]
        ]
      );
      assert.equal(splash.sentStates.at(-1).phase, 'update-error');
      assert.equal(splash.sentStates.at(-1).canProceed, true);

      const proceedResult = await gate.handlers.get('update-gate:proceed')();
      const result = await resultPromise;

      assert.deepEqual(proceedResult, { ok: true });
      assert.deepEqual(result, { ok: true, updateError: true });
      assert.equal(splash.closed, true);
    } finally {
      gate.restore();
    }
  });

  it('stays blocked when updater fails and site is unavailable', async () => {
    const gate = loadUpdateGateWithMocks();
    try {
      const updater = createAutoUpdater({ checkError: new Error('offline updater') });
      const resultPromise = gate.runUpdateGate({
        appUrl: 'https://voiceroom.example',
        autoUpdater: updater,
        checkSiteAvailability: async () => false
      });

      await flush();
      const splash = gate.windows[0];
      assert.deepEqual(
        splash.sentStates.map((state) => [state.phase, state.canProceed]),
        [
          ['checking', undefined],
          ['update-error', false],
          ['site-unavailable', false]
        ]
      );
      assert.equal(splash.sentStates.at(-1).phase, 'site-unavailable');
      assert.equal(splash.sentStates.at(-1).blocked, true);
      assert.equal(splash.sentStates.at(-1).canProceed, false);

      const proceedResult = await gate.handlers.get('update-gate:proceed')();
      assert.deepEqual(proceedResult, { ok: false });

      const race = await Promise.race([
        resultPromise.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20))
      ]);
      assert.equal(race, 'pending');
    } finally {
      gate.restore();
    }
  });


  it('handles duplicate updater failure signals only once', async () => {
    const gate = loadUpdateGateWithMocks();
    try {
      const emittedError = new Error('updater emitted error');
      const rejectedError = new Error('updater rejected');
      const updater = createAutoUpdater();
      updater.checkForUpdates = async () => {
        updater.emit('error', emittedError);
        throw rejectedError;
      };
      let siteChecks = 0;

      gate.runUpdateGate({
        appUrl: 'https://voiceroom.example',
        autoUpdater: updater,
        checkSiteAvailability: async () => {
          siteChecks += 1;
          return true;
        }
      });

      await flush();
      await flush();

      const splash = gate.windows[0];
      assert.equal(siteChecks, 1);
      assert.deepEqual(
        splash.sentStates.map((state) => [state.phase, state.canProceed]),
        [
          ['checking', undefined],
          ['update-error', false],
          ['update-error', true]
        ]
      );
    } finally {
      gate.restore();
    }
  });


  it('shows update error before site check when update download fails', async () => {
    const gate = loadUpdateGateWithMocks();
    try {
      const updater = createAutoUpdater({ downloadError: new Error('download offline') });
      updater.checkForUpdates = async () => {
        updater.emit('update-available');
      };

      const resultPromise = gate.runUpdateGate({
        appUrl: 'https://voiceroom.example',
        autoUpdater: updater,
        checkSiteAvailability: async () => false
      });

      await flush();
      await flush();

      const splash = gate.windows[0];
      assert.deepEqual(
        splash.sentStates.map((state) => [state.phase, state.canProceed]),
        [
          ['checking', undefined],
          ['downloading', undefined],
          ['update-error', false],
          ['site-unavailable', false]
        ]
      );

      const race = await Promise.race([
        resultPromise.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20))
      ]);
      assert.equal(race, 'pending');
    } finally {
      gate.restore();
    }
  });


  it('preserves normal no-update flow', async () => {
    const gate = loadUpdateGateWithMocks();
    try {
      const updater = createAutoUpdater();
      const result = await gate.runUpdateGate({
        appUrl: 'https://voiceroom.example',
        autoUpdater: updater,
        checkSiteAvailability: async () => {
          throw new Error('site check should not run');
        }
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(gate.windows[0].closed, true);
    } finally {
      gate.restore();
    }
  });

  it('preserves successful update install flow', async () => {
    const gate = loadUpdateGateWithMocks();
    const originalSetTimeout = global.setTimeout;
    try {
      const updater = createAutoUpdater();
      updater.checkForUpdates = async () => {
        updater.emit('update-available');
      };
      updater.downloadUpdate = async () => {
        updater.emit('update-downloaded');
      };

      global.setTimeout = (handler, timeout, ...args) => {
        if (timeout === 400) {
          queueMicrotask(() => handler(...args));
          return { unref: () => {} };
        }
        return originalSetTimeout(handler, timeout, ...args);
      };

      const resultPromise = gate.runUpdateGate({
        appUrl: 'https://voiceroom.example',
        autoUpdater: updater,
        checkSiteAvailability: async () => {
          throw new Error('site check should not run');
        }
      });

      await flush();
      await flush();

      assert.deepEqual(updater.quitAndInstallCalls, [[true, true]]);
      const race = await Promise.race([
        resultPromise.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20))
      ]);
      assert.equal(race, 'pending');
    } finally {
      global.setTimeout = originalSetTimeout;
      gate.restore();
    }
  });

});
