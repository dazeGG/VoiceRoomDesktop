'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('preload installs desktop markers without native capture contract modules', () => {
  const preloadPath = path.join(__dirname, '..', 'electron', 'preload.js');
  const source = fs.readFileSync(preloadPath, 'utf8');
  const exposed = new Map();
  const listeners = new Map();
  const invoked = [];
  const classList = new Set();
  const ipcRenderer = {
    invoke: (channel, ...args) => {
      invoked.push([channel, ...args]);
      return Promise.resolve({ ok: true });
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
    removeListener() {}
  };
  const electronMock = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed.set(name, value);
      }
    },
    ipcRenderer
  };
  const documentElement = {
    classList: {
      add: (name) => classList.add(name)
    },
    dataset: {}
  };

  const context = {
    console,
    document: { documentElement },
    navigator: {},
    process: {
      argv: ['electron', '--voice-room-desktop-version=1.2.3-test'],
      platform: 'darwin'
    },
    require(request) {
      if (request === 'electron') {
        return electronMock;
      }
      if (request.includes('capture-contract')) {
        throw new Error(`module not found: ${request}`);
      }
      throw new Error(`unexpected require: ${request}`);
    },
    window: {
      addEventListener() {},
      location: { origin: 'https://voice.example' },
      postMessage() {}
    }
  };
  context.globalThis = context;

  assert.doesNotThrow(() => vm.runInNewContext(source, context, { filename: preloadPath }));
  assert.equal(classList.has('is-desktop'), true);
  assert.equal(documentElement.dataset.electron, 'true');
  const runtime = exposed.get('voiceRoomRuntime');
  assert.equal(runtime.isDesktop, true);
  assert.equal(runtime.isElectron, true);
  assert.equal(runtime.platform, 'darwin');
  assert.equal(runtime.version, '1.2.3-test');
  assert.equal(exposed.get('voiceRoomDesktop'), runtime);
  assert.equal(typeof exposed.get('voiceRoomNativeCaptureBridge')?.prepare, 'function');
  assert.equal(typeof listeners.get('native-capture:port'), 'function');

  const notifications = exposed.get('voiceRoomDesktopNotifications');
  assert.deepEqual(Object.keys(notifications), ['show']);
  assert.equal(typeof notifications.show, 'function');
  notifications.show({ body: 'Body', title: 'Title' });
  assert.deepEqual(invoked.at(-1), [
    'desktop-notifications:show',
    { body: 'Body', title: 'Title' }
  ]);

  for (const [name, value] of exposed) {
    assert.notEqual(value?.invoke, ipcRenderer.invoke, `${name} must not expose raw ipcRenderer`);
    assert.equal(value?.send, undefined, `${name} must not expose ipcRenderer.send`);
  }
});


test('preload inline native-capture constants stay in sync with contract module', () => {
  const preloadSource = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'preload.js'),
    'utf8'
  );
  const {
    NATIVE_CAPTURE_PORT_MESSAGE_TYPE,
    NATIVE_CAPTURE_PROTOCOL_VERSION
  } = require('../electron/native/capture-contract');

  const protocolVersionMatch = preloadSource.match(
    /const\s+NATIVE_CAPTURE_PROTOCOL_VERSION\s*=\s*(\d+)\s*;/
  );
  assert.ok(protocolVersionMatch);
  assert.equal(Number(protocolVersionMatch[1]), NATIVE_CAPTURE_PROTOCOL_VERSION);

  const portMessageTypeMatch = preloadSource.match(
    /const\s+NATIVE_CAPTURE_PORT_MESSAGE_TYPE\s*=\s*(['"])(.*?)\1\s*;/
  );
  assert.ok(portMessageTypeMatch);
  assert.equal(portMessageTypeMatch[2], NATIVE_CAPTURE_PORT_MESSAGE_TYPE);
});
