'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const { it } = require('node:test');

const {
  handleHelperEvent,
  handleReconfigure,
  parseHelperStderrChunk
} = require('../electron/native/capture-relay');

function loadLiveReconfigureHarness() {
  const originalLoad = Module._load;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const handlers = new Map();
  const helperStdinWrites = [];
  const relayMessages = [];

  const relaySession = {
    child: {
      stdin: {
        writable: true,
        write: (value) => helperStdinWrites.push(value)
      }
    },
    fps: 30,
    maxHeight: 1080,
    maxWidth: 1920,
    pendingReconfigures: new Map()
  };

  class FakeRelay extends EventEmitter {
    constructor() {
      super();
      this.pid = 1;
    }

    kill() {}

    postMessage(message) {
      relayMessages.push(message);
      if (message.type !== 'reconfigure') return;
      assert.equal(handleReconfigure(relaySession, message), true);
      setImmediate(() => {
        const stderrAck = `${JSON.stringify({
          event: 'reconfigured',
          fps: message.fps,
          maxHeight: message.maxHeight,
          maxWidth: message.maxWidth,
          requestId: message.requestId
        })}\n`;
        const splitAt = Math.floor(stderrAck.length / 2);
        const stderrState = { buffer: '' };
        assert.deepEqual(parseHelperStderrChunk(stderrState, stderrAck.slice(0, splitAt)), []);
        const events = parseHelperStderrChunk(stderrState, stderrAck.slice(splitAt));
        assert.equal(events.length, 1);
        const result = handleHelperEvent(relaySession, events[0]);
        assert.ok(result);
        this.emit('message', result);
      });
    }
  }

  class FakeMessageChannelMain {
    constructor() {
      this.port1 = { close() {} };
      this.port2 = { close() {} };
    }
  }

  const relay = new FakeRelay();
  const electronMock = {
    app: {
      getAppPath: () => process.cwd(),
      on: () => {}
    },
    BrowserWindow: {
      fromWebContents: () => null
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler)
    },
    MessageChannelMain: FakeMessageChannelMain,
    utilityProcess: {
      fork: () => relay
    }
  };
  const stateMock = {
    cancelDesktopCapturePickerSession: () => {},
    clearPendingDesktopCaptureSource: () => {},
    getDesktopAudioCapabilities: () => ({}),
    getDesktopCapturePickerSessionForEvent: () => ({}),
    getDesktopCaptureSourceForSelection: async () => null,
    getDesktopCaptureSources: async () => [],
    isNativeOnlyScreenCaptureEligible: () => false,
    openDesktopCapturePickerWindow: async () => ({ cancelled: true }),
    peekPendingDesktopCaptureSource: () => null,
    recordGrantedDesktopCapture: () => {},
    resolveDesktopCapturePickerSession: () => {},
    serializeDesktopSource: (source) => source,
    setPendingDesktopCaptureSource: () => ({}),
    storeDesktopCaptureSourceSnapshot: () => {},
    takeGrantedDesktopCapture: () => null,
    takePendingDesktopCaptureSource: () => null
  };
  const securityMock = {
    ensureMacMicrophoneAccess: async () => true,
    getFrameScopeKey: () => 'trusted-frame',
    isTrustedFrame: () => true,
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
    '../electron/native/capture'
  ].map((request) => require.resolve(request));

  modulePaths.forEach((modulePath) => delete require.cache[modulePath]);
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'node:fs') return { ...fs, existsSync: () => true };
    if (request === './state') return stateMock;
    if (request === '../security') return securityMock;
    if (request === '../native/audio') {
      return {
        startSafeSystemAudioCapture: () => ({ sessionId: 'audio' }),
        stopSafeSystemAudioCapture: () => true
      };
    }
    if (request === '../logger') return loggerMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const nativeCapture = require('../electron/native/capture');
    const desktopCapture = require('../electron/desktop-capture/index');
    desktopCapture.configureDesktopCaptureIpc();

    const webContents = new EventEmitter();
    webContents.isDestroyed = () => false;
    webContents.postMessage = () => {};

    const started = nativeCapture.startNativeCaptureSession(webContents, {
      fps: 30,
      maxHeight: 1080,
      maxWidth: 1920,
      qualityId: 'high',
      sourceId: 'screen:1:0'
    });
    assert.equal(started.ok, true);

    return {
      applyProfile: handlers.get('desktop-capture:apply-profile'),
      cleanup() {
        nativeCapture.stopNativeCaptureSession();
        relay.emit('message', { code: 0, reason: 'stopped', type: 'exited' });
        Module._load = originalLoad;
        Object.defineProperty(process, 'platform', platformDescriptor);
        modulePaths.forEach((modulePath) => delete require.cache[modulePath]);
      },
      helperStdinWrites,
      pendingReconfigures: relaySession.pendingReconfigures,
      relayMessages
    };
  } catch (error) {
    Module._load = originalLoad;
    Object.defineProperty(process, 'platform', platformDescriptor);
    modulePaths.forEach((modulePath) => delete require.cache[modulePath]);
    throw error;
  }
}

it('normalizes apply-profile through the active native session into exact helper stdin JSON', async () => {
  const harness = loadLiveReconfigureHarness();

  try {
    const result = await harness.applyProfile(
      { sender: {}, senderFrame: {} },
      { fpsId: '5', qualityId: 'low' }
    );

    assert.deepEqual(result, {
      fpsId: '5',
      maxHeight: 540,
      maxWidth: 960,
      ok: true,
      qualityId: 'low'
    });

    const reconfigureMessage = harness.relayMessages.at(-1);
    assert.deepEqual(reconfigureMessage, {
      fps: 5,
      maxHeight: 540,
      maxWidth: 960,
      requestId: reconfigureMessage.requestId,
      type: 'reconfigure'
    });
    assert.equal(Number.isInteger(reconfigureMessage.requestId), true);

    assert.deepEqual(harness.helperStdinWrites, [
      `{"cmd":"reconfigure","fps":5,"maxHeight":540,"maxWidth":960,"requestId":${reconfigureMessage.requestId}}\n`
    ]);
    assert.equal(harness.pendingReconfigures.size, 0);
  } finally {
    harness.cleanup();
  }
});
