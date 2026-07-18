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
  assert.equal(typeof exposed.get('voiceRoomNativeCaptureBridge')?.requestPort, 'function');
  assert.equal(typeof listeners.get('native-capture:port'), 'function');

  const notifications = exposed.get('voiceRoomDesktopNotifications');
  assert.deepEqual(Object.keys(notifications), ['show']);
  assert.equal(typeof notifications.show, 'function');
  notifications.show({ body: 'Body', title: 'Title' });
  assert.deepEqual(invoked.at(-1), [
    'desktop-notifications:show',
    { body: 'Body', title: 'Title' }
  ]);

  const idle = exposed.get('voiceRoomDesktopIdle');
  assert.deepEqual(Object.keys(idle), ['getSystemIdleTime']);
  assert.equal(typeof idle.getSystemIdleTime, 'function');
  idle.getSystemIdleTime();
  assert.deepEqual(invoked.at(-1), ['desktop-idle:get-system-idle-time']);

  const hotkeys = exposed.get('voiceRoomDesktopHotkeys');
  assert.deepEqual(Object.keys(hotkeys), ['configure', 'onAction', 'onStatus', 'setSuspended']);
  hotkeys.configure({ active: true, bindings: {} });
  assert.deepEqual(invoked.at(-1), ['desktop-hotkeys:configure', { active: true, bindings: {} }]);
  let hotkeyAction = null;
  hotkeys.onAction((payload) => {
    hotkeyAction = payload;
  });
  listeners.get('desktop-hotkeys:action')({}, { action: 'mic-mute', phase: 'pressed' });
  assert.deepEqual(hotkeyAction, { action: 'mic-mute', phase: 'pressed' });
  let hotkeyStatus = null;
  hotkeys.onStatus((payload) => {
    hotkeyStatus = payload;
  });
  listeners.get('desktop-hotkeys:status')({}, { active: true, registered: ['mic-mute'] });
  assert.deepEqual(hotkeyStatus, { active: true, registered: ['mic-mute'] });
  hotkeys.setSuspended(true);
  assert.deepEqual(invoked.at(-1), ['desktop-hotkeys:set-suspended', true]);

  for (const [name, value] of exposed) {
    assert.notEqual(value?.invoke, ipcRenderer.invoke, `${name} must not expose raw ipcRenderer`);
    assert.equal(value?.send, undefined, `${name} must not expose ipcRenderer.send`);
  }
});

test('preload bounds and correlates native capture port handoff', () => {
  const preloadPath = path.join(__dirname, '..', 'electron', 'preload.js');
  const source = fs.readFileSync(preloadPath, 'utf8');
  const exposed = new Map();
  const listeners = new Map();
  const posted = [];
  const timers = new Map();
  let nextTimerId = 1;
  const context = {
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    console,
    document: {
      documentElement: {
        classList: { add() {} },
        dataset: {}
      }
    },
    navigator: {},
    process: { argv: ['electron'], platform: 'win32' },
    require(request) {
      if (request !== 'electron') throw new Error(`unexpected require: ${request}`);
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            exposed.set(name, value);
          }
        },
        ipcRenderer: {
          invoke: async () => ({ ok: true }),
          on(channel, listener) {
            listeners.set(channel, listener);
          },
          removeListener() {}
        }
      };
    },
    setTimeout(callback) {
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    },
    window: {
      addEventListener() {},
      location: { origin: 'https://voice.example' },
      postMessage(message, targetOrigin, ports) {
        posted.push({ message, ports, targetOrigin });
      }
    }
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: preloadPath });

  const bridge = exposed.get('voiceRoomNativeCaptureBridge');
  const deliverPort = listeners.get('native-capture:port');
  const { NATIVE_CAPTURE_PROTOCOL_VERSION } = require('../electron/native/capture-contract');
  const sessionId = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const createPort = () => ({
    closed: 0,
    close() { this.closed += 1; }
  });
  const deliver = (id, port, extraPorts = []) => deliverPort(
    { ports: [port, ...extraPorts] },
    { protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION, sessionId: id }
  );
  const runTimer = (timerId) => {
    const callback = timers.get(timerId);
    assert.equal(typeof callback, 'function');
    timers.delete(timerId);
    callback();
  };

  const earlyPort = createPort();
  deliver(sessionId(1), earlyPort);
  assert.equal(posted.length, 0);
  assert.equal(bridge.requestPort(sessionId(1)), true);
  assert.equal(posted.at(-1).ports[0], earlyPort);

  const latePort = createPort();
  assert.equal(bridge.requestPort(sessionId(2)), true);
  deliver(sessionId(2), latePort);
  assert.equal(posted.at(-1).ports[0], latePort);

  const invalidPort = createPort();
  deliver('predictable-session', invalidPort);
  assert.equal(invalidPort.closed, 1);
  assert.equal(bridge.requestPort('predictable-session'), false);

  const duplicateFirst = createPort();
  const duplicateSecond = createPort();
  deliver(sessionId(3), duplicateFirst);
  deliver(sessionId(3), duplicateSecond);
  assert.equal(duplicateFirst.closed, 1);
  assert.equal(bridge.requestPort(sessionId(3)), true);
  assert.equal(posted.at(-1).ports[0], duplicateSecond);

  const pendingFlood = Array.from({ length: 5 }, (_, index) => ({
    id: sessionId(10 + index),
    port: createPort()
  }));
  for (const entry of pendingFlood) deliver(entry.id, entry.port);
  assert.equal(pendingFlood[0].port.closed, 1);
  for (const entry of pendingFlood.slice(1)) {
    assert.equal(bridge.requestPort(entry.id), true);
  }
  assert.deepEqual(
    posted.slice(-4).map((entry) => entry.ports[0]),
    pendingFlood.slice(1).map((entry) => entry.port)
  );

  // The evicted pending id can only be accepted after a fresh explicit request.
  const recoveredEvictedPort = createPort();
  assert.equal(bridge.requestPort(pendingFlood[0].id), true);
  deliver(pendingFlood[0].id, recoveredEvictedPort);
  assert.equal(posted.at(-1).ports[0], recoveredEvictedPort);

  const requestedFlood = Array.from({ length: 5 }, (_, index) => sessionId(20 + index));
  for (const id of requestedFlood) assert.equal(bridge.requestPort(id), true);
  const evictedRequestPort = createPort();
  const retainedRequestPort = createPort();
  const postedBeforeRequestedDelivery = posted.length;
  deliver(requestedFlood[0], evictedRequestPort);
  assert.equal(posted.length, postedBeforeRequestedDelivery);
  deliver(requestedFlood[1], retainedRequestPort);
  assert.equal(posted.at(-1).ports[0], retainedRequestPort);
  assert.equal(bridge.requestPort(requestedFlood[0]), true);
  assert.equal(posted.at(-1).ports[0], evictedRequestPort);

  const expiringRequestId = sessionId(30);
  assert.equal(bridge.requestPort(expiringRequestId), true);
  const expiringRequestTimer = nextTimerId - 1;
  runTimer(expiringRequestTimer);
  const portAfterExpiredRequest = createPort();
  const postedBeforeExpiredRequestDelivery = posted.length;
  deliver(expiringRequestId, portAfterExpiredRequest);
  assert.equal(posted.length, postedBeforeExpiredRequestDelivery);
  assert.equal(bridge.requestPort(expiringRequestId), true);
  assert.equal(posted.at(-1).ports[0], portAfterExpiredRequest);

  const expiringPort = createPort();
  deliver(sessionId(31), expiringPort);
  const expiringPortTimer = nextTimerId - 1;
  runTimer(expiringPortTimer);
  assert.equal(expiringPort.closed, 1);
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

test('native capture sessions use unguessable UUID identifiers', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'native', 'capture.js'),
    'utf8'
  );

  assert.match(source, /const \{ randomUUID \} = require\('node:crypto'\)/);
  assert.match(source, /const sessionId = randomUUID\(\)/);
  assert.doesNotMatch(source, /nextSessionId/);
});
