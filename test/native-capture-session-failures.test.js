'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const { describe, it } = require('node:test');

class FakeRelay extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.pid = 41;
    this.throwOnReconfigure = false;
  }

  kill() {}

  postMessage(message) {
    this.messages.push(message);
    if (message.type === 'reconfigure' && this.throwOnReconfigure) {
      throw new Error('relay unavailable');
    }
  }
}

class FakePort {
  close() {}
}

function loadCaptureSessionHarness() {
  const originalLoad = Module._load;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const modulePath = require.resolve('../electron/native/capture');
  const timers = new Set();
  const relay = new FakeRelay();

  class FakeMessageChannelMain {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
    }
  }

  const electronMock = {
    app: {
      getAppPath: () => '/voice-room-desktop',
      on: () => {}
    },
    MessageChannelMain: FakeMessageChannelMain,
    utilityProcess: {
      fork: () => relay
    }
  };
  const loggerMock = {
    error: () => {},
    info: () => {},
    warn: () => {}
  };

  global.setTimeout = (callback, delay, ...args) => {
    const timer = {
      callback: () => callback(...args),
      delay,
      unref() { return this; }
    };
    timers.add(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    timers.delete(timer);
  };
  delete require.cache[modulePath];
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'node:fs') return { ...fs, existsSync: () => true };
    if (request === '../logger') return loggerMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  let nativeCapture;
  try {
    nativeCapture = require('../electron/native/capture');
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
      cleanup() {
        nativeCapture.stopNativeCaptureSession();
        relay.emit('message', { code: 0, reason: 'stopped', type: 'exited' });
        Module._load = originalLoad;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        Object.defineProperty(process, 'platform', platformDescriptor);
        delete require.cache[modulePath];
      },
      nativeCapture,
      relay,
      runTimers(delay) {
        const due = [...timers].filter((timer) => timer.delay === delay);
        for (const timer of due) {
          timers.delete(timer);
          timer.callback();
        }
        return due.length;
      },
      started,
      timerCount: () => timers.size
    };
  } catch (error) {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    Object.defineProperty(process, 'platform', platformDescriptor);
    delete require.cache[modulePath];
    throw error;
  }
}

describe('native capture reconfigure session failures', { concurrency: false }, () => {
  it('times out a helper request and ignores a late ACK', async () => {
    const harness = loadCaptureSessionHarness();
    try {
      const resultPromise = harness.nativeCapture.reconfigureNativeCaptureSession({
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280
      });
      const request = harness.relay.messages.at(-1);
      assert.equal(request.type, 'reconfigure');
      assert.equal(harness.runTimers(2500), 1);
      assert.deepEqual(await resultPromise, { ok: false, reason: 'reconfigure-timeout' });

      harness.relay.emit('message', {
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280,
        ok: true,
        requestId: request.requestId,
        type: 'reconfigured'
      });
      assert.equal(harness.timerCount(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it('turns a synchronous relay post failure into relay-unavailable without leaking a timer', async () => {
    const harness = loadCaptureSessionHarness();
    try {
      harness.relay.throwOnReconfigure = true;
      assert.deepEqual(
        await harness.nativeCapture.reconfigureNativeCaptureSession({ maxHeight: 720, maxWidth: 1280 }),
        { ok: false, reason: 'relay-unavailable' }
      );
      assert.equal(harness.timerCount(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it('ignores a stale request id and resolves only the matching helper ACK', async () => {
    const harness = loadCaptureSessionHarness();
    try {
      let settled = false;
      const resultPromise = harness.nativeCapture.reconfigureNativeCaptureSession({
        fps: 5,
        maxHeight: 540,
        maxWidth: 960
      });
      resultPromise.then(() => { settled = true; });
      const request = harness.relay.messages.at(-1);

      harness.relay.emit('message', {
        ok: true,
        requestId: request.requestId + 100,
        type: 'reconfigured'
      });
      await Promise.resolve();
      assert.equal(settled, false);

      harness.relay.emit('message', {
        fps: 5,
        maxHeight: 540,
        maxWidth: 960,
        ok: true,
        requestId: request.requestId,
        type: 'reconfigured'
      });
      assert.deepEqual(await resultPromise, {
        fps: 5,
        maxHeight: 540,
        maxWidth: 960,
        ok: true
      });
      assert.equal(harness.timerCount(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it('resolves every pending request when the session is stopped', async () => {
    const harness = loadCaptureSessionHarness();
    try {
      const resultPromise = harness.nativeCapture.reconfigureNativeCaptureSession({ maxHeight: 720 });
      assert.equal(harness.nativeCapture.stopNativeCaptureSession(harness.started.sessionId), true);
      assert.deepEqual(await resultPromise, { ok: false, reason: 'session-stopped' });
      assert.equal(harness.timerCount(), 1, 'only the force-kill timer remains until relay exit');
      harness.relay.emit('message', { code: 0, reason: 'stopped', type: 'exited' });
      assert.equal(harness.timerCount(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it('resolves every pending request when the relay errors', async () => {
    const harness = loadCaptureSessionHarness();
    try {
      const resultPromise = harness.nativeCapture.reconfigureNativeCaptureSession({ fps: 15 });
      harness.relay.emit('error', new Error('utility process crashed'));
      assert.deepEqual(await resultPromise, { ok: false, reason: 'session-ended' });
      assert.equal(harness.timerCount(), 0);
    } finally {
      harness.cleanup();
    }
  });
});
