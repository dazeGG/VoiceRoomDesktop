'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const { describe, it } = require('node:test');

class FakeRelay extends EventEmitter {
  constructor() {
    super();
    this.killCalls = 0;
    this.killResult = true;
    this.messages = [];
    this.pid = 41;
    this.throwOnKill = false;
    this.throwOnReconfigure = false;
  }

  kill() {
    this.killCalls += 1;
    if (this.throwOnKill) throw new Error('relay kill failed');
    return this.killResult;
  }

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
  const originalSystemRoot = process.env.SystemRoot;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const modulePath = require.resolve('../electron/native/capture');
  const timers = new Set();
  const treeKills = [];
  let throwOnTreeKill = false;
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
  const childProcessMock = {
    execFile(command, args, options, callback) {
      if (throwOnTreeKill) throw new Error('taskkill spawn failed');
      const invocation = {
        args,
        callback,
        command,
        options,
        unrefCalls: 0
      };
      treeKills.push(invocation);
      return {
        unref() {
          invocation.unrefCalls += 1;
        }
      };
    }
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
  process.env.SystemRoot = 'C:\\Windows';
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'node:child_process') return childProcessMock;
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
        relay.emit('exit', 0);
        Module._load = originalLoad;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        if (originalSystemRoot === undefined) {
          delete process.env.SystemRoot;
        } else {
          process.env.SystemRoot = originalSystemRoot;
        }
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
      setTreeKillThrows(value) {
        throwOnTreeKill = value;
      },
      timerCount: () => timers.size,
      treeKills
    };
  } catch (error) {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = originalSystemRoot;
    }
    Object.defineProperty(process, 'platform', platformDescriptor);
    delete require.cache[modulePath];
    throw error;
  }
}

describe('native capture reconfigure session failures', { concurrency: false }, () => {
  it('fails closed and force-kills an unresponsive relay after the main timeout', async () => {
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
      assert.deepEqual(harness.relay.messages.at(-1), { type: 'stop' });

      harness.relay.emit('message', {
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280,
        ok: true,
        requestId: request.requestId,
        type: 'reconfigured'
      });
      assert.deepEqual(
        await harness.nativeCapture.reconfigureNativeCaptureSession({ fps: 5 }),
        { ok: false, reason: 'no-active-session' }
      );
      assert.equal(harness.timerCount(), 1, 'the bounded relay force-kill timer remains');
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.relay.killCalls, 0, 'tree enforcement runs before UtilityProcess.kill');
      assert.deepEqual(harness.treeKills.map(({ args, command, options, unrefCalls }) => ({
        args,
        command,
        options,
        unrefCalls
      })), [{
        args: ['/PID', '41', '/T', '/F'],
        command: 'C:\\Windows\\System32\\taskkill.exe',
        options: { timeout: 2000, windowsHide: true },
        unrefCalls: 1
      }]);
      assert.equal(harness.timerCount(), 1, 'relay exit has its own bounded enforcement timer');
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.relay.killCalls, 1);
      assert.equal(harness.timerCount(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it('serializes profile transactions and fails closed if a later request times out', async () => {
    const harness = loadCaptureSessionHarness();
    try {
      const firstResultPromise = harness.nativeCapture.reconfigureNativeCaptureSession({
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280
      });
      const firstRequest = harness.relay.messages.at(-1);

      assert.deepEqual(
        await harness.nativeCapture.reconfigureNativeCaptureSession({ fps: 5 }),
        { ok: false, reason: 'reconfigure-in-progress' }
      );
      assert.equal(harness.relay.messages.at(-1), firstRequest);

      harness.relay.emit('message', {
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280,
        ok: true,
        requestId: firstRequest.requestId,
        type: 'reconfigured'
      });
      assert.deepEqual(await firstResultPromise, {
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280,
        ok: true
      });

      const secondResultPromise = harness.nativeCapture.reconfigureNativeCaptureSession({
        fps: 5,
        maxHeight: 540,
        maxWidth: 960
      });
      assert.equal(harness.relay.messages.at(-1).type, 'reconfigure');
      assert.equal(harness.runTimers(2500), 1);
      assert.deepEqual(await secondResultPromise, { ok: false, reason: 'reconfigure-timeout' });
      assert.deepEqual(harness.relay.messages.at(-1), { type: 'stop' });
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.treeKills.length, 1);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.relay.killCalls, 1);
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
      assert.equal(harness.timerCount(), 1, 'a helper exit message is not relay process exit proof');
      harness.relay.emit('exit', 0);
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

  it('records a rejected UtilityProcess fallback only after tree enforcement', () => {
    const harness = loadCaptureSessionHarness();
    try {
      harness.relay.killResult = false;
      assert.equal(harness.nativeCapture.stopNativeCaptureSession(harness.started.sessionId), true);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.treeKills.length, 1);
      assert.deepEqual(harness.treeKills[0].args, ['/PID', '41', '/T', '/F']);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.relay.killCalls, 1);
      assert.equal(harness.timerCount(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it('contains a throwing UtilityProcess fallback after tree enforcement', () => {
    const harness = loadCaptureSessionHarness();
    try {
      harness.relay.throwOnKill = true;
      assert.equal(harness.nativeCapture.stopNativeCaptureSession(harness.started.sessionId), true);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.treeKills.length, 1);
      assert.deepEqual(harness.treeKills[0].args, ['/PID', '41', '/T', '/F']);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.relay.killCalls, 1);
      assert.equal(harness.timerCount(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it('cancels the UtilityProcess fallback when tree enforcement produces relay exit', () => {
    const harness = loadCaptureSessionHarness();
    try {
      assert.equal(harness.nativeCapture.stopNativeCaptureSession(harness.started.sessionId), true);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.treeKills.length, 1);
      assert.equal(harness.relay.killCalls, 0);
      assert.equal(harness.timerCount(), 1);
      harness.relay.emit('exit', 0);
      assert.equal(harness.timerCount(), 0);
      assert.equal(harness.treeKills.length, 1);
    } finally {
      harness.cleanup();
    }
  });

  it('falls back to UtilityProcess.kill when taskkill reports an async failure', () => {
    const harness = loadCaptureSessionHarness();
    try {
      assert.equal(harness.nativeCapture.stopNativeCaptureSession(harness.started.sessionId), true);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.treeKills.length, 1);
      harness.treeKills[0].callback(new Error('access denied'));
      assert.equal(harness.relay.killCalls, 1);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.relay.killCalls, 1, 'the exit timer does not duplicate the fallback kill');
    } finally {
      harness.cleanup();
    }
  });

  it('falls back to UtilityProcess.kill when taskkill cannot spawn', () => {
    const harness = loadCaptureSessionHarness();
    try {
      harness.setTreeKillThrows(true);
      assert.equal(harness.nativeCapture.stopNativeCaptureSession(harness.started.sessionId), true);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.treeKills.length, 0);
      assert.equal(harness.relay.killCalls, 1);
      assert.equal(harness.runTimers(2000), 1);
      assert.equal(harness.relay.killCalls, 1);
    } finally {
      harness.cleanup();
    }
  });
});
