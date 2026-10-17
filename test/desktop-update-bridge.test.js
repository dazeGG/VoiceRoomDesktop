'use strict';

// The hosted page shows one "update available" notice for the web app and the
// shell; the shell reports its downloaded release here and restarts into it
// when the page asks.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  GET_STATE_CHANNEL,
  INSTALL_CHANNEL,
  STATE_CHANNEL,
  createUpdateBridge
} = require('../electron/update-bridge');

const quietLog = { info() {}, warn() {} };
const isTrustedUrl = (url) => url.startsWith('https://voiceroom.ru/');
const trustedFrame = { url: 'https://voiceroom.ru/' };
const isTrustedFrame = (frame) => isTrustedUrl(frame?.url || '');

function fakeWindow(url = 'https://voiceroom.ru/') {
  return {
    isDestroyed: () => false,
    webContents: {
      sent: [],
      getURL: () => url,
      isDestroyed: () => false,
      send(channel, payload) {
        this.sent.push([channel, payload]);
      }
    }
  };
}

function fakeUpdater(state = { phase: 'idle', version: '' }) {
  const updater = {
    state,
    installs: [],
    getState: () => updater.state,
    installNow(options) {
      if (updater.state.phase !== 'ready') return false;
      updater.installs.push(options);
      return true;
    }
  };
  return updater;
}

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    invoke: (channel, frame = trustedFrame) => handlers.get(channel)({ senderFrame: frame })
  };
}

test('the page learns of a release as it downloads and when it is ready, once per change', () => {
  const bridge = createUpdateBridge({ isTrustedUrl, log: quietLog });
  const window = fakeWindow();
  const updater = fakeUpdater();
  bridge.attachWindow(window);
  bridge.attachUpdater(updater);

  updater.state = { phase: 'checking', version: '' };
  bridge.publish();
  updater.state = { phase: 'downloading', version: '' };
  bridge.publish();
  bridge.publish();
  updater.state = { phase: 'ready', version: '1.5.0' };
  bridge.publish();

  assert.deepEqual(window.webContents.sent, [
    [STATE_CHANNEL, { status: 'none', version: '' }],
    [STATE_CHANNEL, { status: 'downloading', version: '' }],
    [STATE_CHANNEL, { status: 'ready', version: '1.5.0' }]
  ]);
});

test('a foreign page never hears about updates', () => {
  const bridge = createUpdateBridge({ isTrustedUrl, log: quietLog });
  const window = fakeWindow('https://evil.example/');
  bridge.attachWindow(window);
  bridge.attachUpdater(fakeUpdater({ phase: 'ready', version: '1.5.0' }));

  assert.deepEqual(window.webContents.sent, []);
});

test('the page reads the state and starts the restart into a ready release', async () => {
  const bridge = createUpdateBridge({ isTrustedUrl, log: quietLog });
  const updater = fakeUpdater({ phase: 'ready', version: '1.5.0' });
  bridge.attachUpdater(updater);
  const ipc = fakeIpc();
  bridge.configureIpc({ ipcMain: ipc.ipcMain, isTrustedFrame });

  assert.deepEqual(await ipc.invoke(GET_STATE_CHANNEL), { status: 'ready', version: '1.5.0' });
  assert.equal(await ipc.invoke(INSTALL_CHANNEL), true);
  // The restart reopens the window: the user asked for it from the page.
  assert.deepEqual(updater.installs, [{ startHidden: false }]);
});

test('nothing installs without a downloaded release, without an updater or from a foreign frame', async () => {
  const bridge = createUpdateBridge({ isTrustedUrl, log: quietLog });
  const ipc = fakeIpc();
  bridge.configureIpc({ ipcMain: ipc.ipcMain, isTrustedFrame });

  // A development build runs no background updater.
  assert.deepEqual(await ipc.invoke(GET_STATE_CHANNEL), { status: 'none', version: '' });
  assert.throws(() => ipc.invoke(INSTALL_CHANNEL), /No downloaded update/);

  const updater = fakeUpdater({ phase: 'downloading', version: '' });
  bridge.attachUpdater(updater);
  assert.throws(() => ipc.invoke(INSTALL_CHANNEL), /No downloaded update/);

  updater.state = { phase: 'ready', version: '1.5.0' };
  assert.throws(() => ipc.invoke(INSTALL_CHANNEL, { url: 'https://evil.example/' }), /configured VoiceRoom URL/);
  assert.deepEqual(updater.installs, []);
});
