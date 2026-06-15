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
  const classList = new Set();
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
        return {
          contextBridge: {
            exposeInMainWorld(name, value) {
              exposed.set(name, value);
            }
          },
          ipcRenderer: {
            invoke: () => Promise.resolve(),
            on(channel, listener) {
              listeners.set(channel, listener);
            },
            removeListener() {}
          }
        };
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
});
