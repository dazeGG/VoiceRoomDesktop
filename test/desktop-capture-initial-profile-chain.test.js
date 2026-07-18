'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const { test } = require('node:test');

const { NATIVE_CAPTURE_PROTOCOL_VERSION } = require('../electron/native/capture-contract');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.killed = false;
    this.stderr = new EventEmitter();
    this.stdout = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.writable = true;
    this.stdin.writes = [];
    this.stdin.write = (value) => {
      this.stdin.writes.push(value);
      return true;
    };
  }

  kill() {
    this.killed = true;
    return true;
  }
}

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.messages = [];
  }

  close() {
    this.closed = true;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  start() {}
}

function getArg(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing helper argument ${name}`);
  return args[index + 1];
}

function loadInitialProfileHarness() {
  const originalLoad = Module._load;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const parentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const originalDisconnectListeners = new Set(process.listeners('disconnect'));
  const originalExitListeners = new Set(process.listeners('exit'));
  const handlers = new Map();
  const helperSpawns = [];
  const relayMessages = [];
  const relays = [];

  const parentPort = new EventEmitter();
  parentPort.messages = [];
  parentPort.postMessage = (message) => parentPort.messages.push(message);
  parentPort.start = () => {};

  class FakeRelay extends EventEmitter {
    constructor() {
      super();
      this.pid = relays.length + 1;
      relays.push(this);
    }

    kill() {}

    postMessage(message, ports = []) {
      relayMessages.push(message);
      parentPort.emit('message', { data: message, ports });
      if (message.type === 'stop') {
        this.emit('message', { code: 0, reason: 'stopped', type: 'exited' });
      }
    }
  }

  class FakeMessageChannelMain {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
    }
  }

  class FakeBrowserWindow {
    static fromWebContents() { return null; }
    static getAllWindows() { return []; }
  }

  const electronMock = {
    app: {
      getAppPath: () => '/voice-room-desktop',
      on: () => {}
    },
    BrowserWindow: FakeBrowserWindow,
    desktopCapturer: {
      getSources: async () => []
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler)
    },
    MessageChannelMain: FakeMessageChannelMain,
    utilityProcess: {
      fork: () => new FakeRelay()
    }
  };
  const audioMock = {
    getNativeAudioCapabilities: () => ({
      available: false,
      modes: { application: false, safeSystem: false }
    }),
    startSafeSystemAudioCapture: () => ({ sessionId: 'audio' }),
    stopSafeSystemAudioCapture: () => true
  };
  const securityMock = {
    assertMacScreenCaptureAccess: () => {},
    createMacScreenCaptureAccessError: (error) => error,
    ensureMacMicrophoneAccess: async () => true,
    getFrameScopeKey: (frame) => frame?.scopeKey || '',
    isTrustedFrame: () => true,
    isTrustedOrigin: () => true,
    isTrustedOrAppLoadingFrame: () => true,
    openMacMicrophoneSettings: () => {},
    openMacScreenCaptureSettings: () => {}
  };
  const loggerMock = {
    error: () => {},
    info: () => {},
    warn: () => {}
  };
  const modulePaths = [
    '../electron/desktop-capture/index',
    '../electron/desktop-capture/state',
    '../electron/native/capture',
    '../electron/native/capture-relay'
  ].map((request) => require.resolve(request));

  modulePaths.forEach((modulePath) => delete require.cache[modulePath]);
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
    writable: true
  });
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'node:child_process') {
      return {
        spawn(command, args, options) {
          const child = new FakeChild();
          helperSpawns.push({ args: [...args], child, command, options });
          return child;
        }
      };
    }
    if (request === 'node:fs') return { ...fs, existsSync: () => true };
    if (request === '../native/audio') return audioMock;
    if (request === '../security') return securityMock;
    if (request === '../logger') return loggerMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  let nativeCapture;
  try {
    require('../electron/native/capture-relay');
    nativeCapture = require('../electron/native/capture');
    const state = require('../electron/desktop-capture/state');
    const desktopCapture = require('../electron/desktop-capture/index');
    desktopCapture.configureDesktopCaptureIpc();

    return {
      cleanup() {
        nativeCapture.stopNativeCaptureSession();
        for (const listener of process.listeners('disconnect')) {
          if (!originalDisconnectListeners.has(listener)) process.removeListener('disconnect', listener);
        }
        for (const listener of process.listeners('exit')) {
          if (!originalExitListeners.has(listener)) process.removeListener('exit', listener);
        }
        Module._load = originalLoad;
        Object.defineProperty(process, 'platform', platformDescriptor);
        if (parentPortDescriptor) {
          Object.defineProperty(process, 'parentPort', parentPortDescriptor);
        } else {
          delete process.parentPort;
        }
        modulePaths.forEach((modulePath) => delete require.cache[modulePath]);
      },
      handlers,
      helperSpawns,
      relayMessages,
      state
    };
  } catch (error) {
    Module._load = originalLoad;
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (parentPortDescriptor) {
      Object.defineProperty(process, 'parentPort', parentPortDescriptor);
    } else {
      delete process.parentPort;
    }
    modulePaths.forEach((modulePath) => delete require.cache[modulePath]);
    throw error;
  }
}

test('selected 720p and 1080p profiles reach the production helper start arguments', async () => {
  const harness = loadInitialProfileHarness();
  const sender = new EventEmitter();
  const senderFrame = { scopeKey: 'room-frame' };
  const event = { sender, senderFrame };
  sender.isDestroyed = () => false;
  sender.postMessage = () => {};

  try {
    const selectSource = harness.handlers.get('desktop-capture:select-source');
    const prepareNative = harness.handlers.get('native-capture:prepare');
    const startNative = harness.handlers.get('native-capture:start');
    assert.equal(typeof selectSource, 'function');
    assert.equal(typeof prepareNative, 'function');
    assert.equal(typeof startNative, 'function');

    const balancedSource = { id: 'screen:101:0', name: 'Ultrawide display' };
    harness.state.storeDesktopCaptureSourceSnapshot(senderFrame.scopeKey, [balancedSource]);
    const balancedSelection = await selectSource(
      event,
      balancedSource.id,
      { enabled: false },
      { fpsId: '30', qualityId: 'balanced' }
    );
    assert.deepEqual(balancedSelection, {
      audioCapture: {
        mode: 'none',
        requestedMode: 'none',
        sourceType: 'screen',
        warning: ''
      },
      fpsId: '30',
      maxHeight: 720,
      maxWidth: 1280,
      ok: true,
      qualityId: 'balanced'
    });

    const balancedStart = prepareNative(event);
    assert.equal(balancedStart.ok, true);
    assert.equal(balancedStart.protocolVersion, NATIVE_CAPTURE_PROTOCOL_VERSION);
    assert.equal(balancedStart.maxHeight, 720);
    assert.equal(balancedStart.maxWidth, 1280);
    const balancedRelayStart = harness.relayMessages.find((message) => message.type === 'start');
    assert.match(balancedRelayStart.helperPath, /ScreenCursorCapture\.exe$/);
    assert.deepEqual(
      balancedRelayStart,
      {
        fps: 30,
        helperPath: balancedRelayStart.helperPath,
        maxHeight: 720,
        maxWidth: 1280,
        protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
        qualityId: 'balanced',
        sourceId: balancedSource.id,
        type: 'start'
      }
    );
    assert.equal(getArg(harness.helperSpawns[0].args, '--max-height'), '720');
    assert.equal(getArg(harness.helperSpawns[0].args, '--max-width'), '1280');

    const highSource = { id: 'screen:202:0', name: '16:9 display' };
    harness.state.storeDesktopCaptureSourceSnapshot(senderFrame.scopeKey, [highSource]);
    await selectSource(
      event,
      highSource.id,
      { enabled: false },
      { fpsId: '30', qualityId: 'high' }
    );
    const pendingHigh = harness.state.takePendingDesktopCaptureSource(senderFrame);
    assert.equal(pendingHigh.maxHeight, 1080);
    assert.equal(pendingHigh.maxWidth, 1920);
    harness.state.recordGrantedDesktopCapture(senderFrame, pendingHigh);

    const highStart = startNative(event);
    assert.equal(highStart.ok, true);
    assert.equal(highStart.maxHeight, 1080);
    assert.equal(highStart.maxWidth, 1920);
    const highRelayStart = harness.relayMessages.filter((message) => message.type === 'start').at(-1);
    assert.equal(highRelayStart.maxHeight, 1080);
    assert.equal(highRelayStart.maxWidth, 1920);
    assert.equal(highRelayStart.sourceId, highSource.id);
    assert.equal(getArg(harness.helperSpawns[1].args, '--max-height'), '1080');
    assert.equal(getArg(harness.helperSpawns[1].args, '--max-width'), '1920');
  } finally {
    harness.cleanup();
  }
});
