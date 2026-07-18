'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { describe, it } = require('node:test');

const {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC
} = require('../electron/native/capture-frames');
const { NATIVE_CAPTURE_PROTOCOL_VERSION } = require('../electron/native/capture-contract');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.killSignals = [];
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

  kill(signal) {
    this.killSignals.push(signal);
    this.killed = true;
    return true;
  }
}

class FakeRendererPort extends EventEmitter {
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

function makeBgrxFrame({ height = 2, timestampMs = 1n, width = 2 } = {}) {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(FRAME_MAGIC, 0);
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header.writeUInt32LE(0, 12);
  header.writeBigInt64LE(timestampMs, 16);
  return Buffer.concat([header, Buffer.alloc(width * height * 4, Number(timestampMs % 251n))]);
}

function helperAck(requestId, values = {}) {
  return Buffer.from(`${JSON.stringify({
    event: 'reconfigured',
    fps: values.fps || 30,
    maxHeight: values.maxHeight || 1080,
    maxWidth: values.maxWidth || 1920,
    requestId
  })}\n`);
}

function loadRelayHarness() {
  const originalLoad = Module._load;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetImmediate = global.setImmediate;
  const parentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const originalDisconnectListeners = new Set(process.listeners('disconnect'));
  const originalExitListeners = new Set(process.listeners('exit'));
  const modulePath = require.resolve('../electron/native/capture-relay');
  const children = [];
  const immediateCallbacks = [];
  const intervals = new Set();
  const parentMessages = [];
  const spawnCalls = [];
  const timeouts = new Set();

  const parentPort = new EventEmitter();
  parentPort.postMessage = (message) => parentMessages.push(message);
  parentPort.start = () => {};

  global.setTimeout = (callback, delay, ...args) => {
    const timer = {
      callback: () => callback(...args),
      delay,
      unref() { return this; }
    };
    timeouts.add(timer);
    return timer;
  };
  global.clearTimeout = (timer) => timeouts.delete(timer);
  global.setInterval = (callback, delay, ...args) => {
    const timer = {
      callback: () => callback(...args),
      delay,
      unref() { return this; }
    };
    intervals.add(timer);
    return timer;
  };
  global.clearInterval = (timer) => intervals.delete(timer);
  global.setImmediate = (callback, ...args) => {
    immediateCallbacks.push(() => callback(...args));
    return immediateCallbacks.length;
  };

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
    writable: true
  });
  delete require.cache[modulePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'node:child_process') {
      return {
        spawn(command, args, options) {
          const child = new FakeChild();
          children.push(child);
          spawnCalls.push({ args: [...args], command, options });
          return child;
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    require('../electron/native/capture-relay');
    let port = null;
    return {
      children,
      cleanup() {
        parentPort.emit('message', { data: { type: 'stop' }, ports: [] });
        for (const listener of process.listeners('disconnect')) {
          if (!originalDisconnectListeners.has(listener)) process.removeListener('disconnect', listener);
        }
        for (const listener of process.listeners('exit')) {
          if (!originalExitListeners.has(listener)) process.removeListener('exit', listener);
        }
        Module._load = originalLoad;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        global.setImmediate = originalSetImmediate;
        if (parentPortDescriptor) {
          Object.defineProperty(process, 'parentPort', parentPortDescriptor);
        } else {
          delete process.parentPort;
        }
        delete require.cache[modulePath];
      },
      exitChild(index, code, signal = null) {
        const child = children[index];
        child.exitCode = code;
        child.emit('exit', code, signal);
      },
      immediateCount: () => immediateCallbacks.length,
      parentMessages,
      port: () => port,
      runTimeouts(delay) {
        const due = [...timeouts].filter((timer) => timer.delay === delay);
        for (const timer of due) {
          timeouts.delete(timer);
          timer.callback();
        }
        return due.length;
      },
      send(message) {
        parentPort.emit('message', { data: message, ports: [] });
      },
      spawnCalls,
      start(options = {}) {
        port = new FakeRendererPort();
        parentPort.emit('message', {
          data: {
            fps: 30,
            helperPath: 'C:\\VoiceRoom\\ScreenCursorCapture.exe',
            maxHeight: 1080,
            maxWidth: 1920,
            protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
            qualityId: 'high',
            sourceId: 'screen:1:0',
            type: 'start',
            ...options
          },
          ports: [port]
        });
        return port;
      },
      timeoutCount: () => timeouts.size
    };
  } catch (error) {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setImmediate = originalSetImmediate;
    if (parentPortDescriptor) {
      Object.defineProperty(process, 'parentPort', parentPortDescriptor);
    } else {
      delete process.parentPort;
    }
    delete require.cache[modulePath];
    throw error;
  }
}

describe('native capture relay child lifecycle', { concurrency: false }, () => {
  it('restarts with the same profile, resets partial frame parsing, and reapplies pause state', () => {
    const harness = loadRelayHarness();
    try {
      const port = harness.start({
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280,
        qualityId: 'balanced',
        sourceId: 'screen:9:0'
      });
      assert.equal(harness.children.length, 1);
      const firstSpawn = harness.spawnCalls[0];
      assert.deepEqual(firstSpawn.args, [
        '--source', 'screen:9:0',
        '--fps', '15',
        '--max-height', '720',
        '--max-width', '1280'
      ]);

      harness.children[0].stdout.emit('data', Buffer.concat([
        makeBgrxFrame({ timestampMs: 1n }),
        makeBgrxFrame({ timestampMs: 2n })
      ]));
      assert.equal(port.messages.filter((message) => message.type === 'frame').length, 2);
      assert.deepEqual(harness.children[0].stdin.writes, [
        '{"cmd":"set-paused","paused":true}\n'
      ]);

      // This incomplete next header must not contaminate the replacement
      // child's parser after the helper crashes.
      harness.children[0].stdout.emit('data', Buffer.from([0xaa, 0xbb, 0xcc]));
      harness.exitChild(0, 1);

      assert.equal(harness.children.length, 2);
      assert.deepEqual(harness.spawnCalls[1], firstSpawn);
      assert.deepEqual(harness.children[1].stdin.writes, [
        '{"cmd":"set-paused","paused":true}\n'
      ]);

      port.emit('message', { data: { type: 'frame-ack' } });
      harness.children[1].stdout.emit('data', makeBgrxFrame({ timestampMs: 3n }));
      const frames = port.messages.filter((message) => message.type === 'frame');
      assert.equal(frames.length, 3);
      assert.equal(frames.at(-1).timestampMs, 3);
      assert.deepEqual(harness.children[1].stdin.writes, [
        '{"cmd":"set-paused","paused":true}\n',
        '{"cmd":"set-paused","paused":false}\n',
        '{"cmd":"set-paused","paused":true}\n'
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it('correlates helper ACKs and rolls an uncertain timeout back before continuing', () => {
    const harness = loadRelayHarness();
    try {
      harness.start();
      harness.send({
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280,
        requestId: 10,
        type: 'reconfigure'
      });
      assert.deepEqual(harness.children[0].stdin.writes, [
        '{"cmd":"reconfigure","fps":15,"maxHeight":720,"maxWidth":1280,"requestId":10}\n'
      ]);

      harness.children[0].stderr.emit('data', helperAck(11, {
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280
      }));
      assert.equal(
        harness.parentMessages.some((message) => message.type === 'reconfigured'),
        false,
        'a stale helper ACK must not finish another request'
      );
      harness.children[0].stderr.emit('data', helperAck(10, {
        fps: 15,
        maxHeight: 720,
        maxWidth: 1280
      }));
      assert.deepEqual(
        harness.parentMessages.filter((message) => message.type === 'reconfigured').at(-1),
        {
          fps: 15,
          maxHeight: 720,
          maxWidth: 1280,
          ok: true,
          requestId: 10,
          type: 'reconfigured'
        }
      );

      harness.send({ maxHeight: 540, maxWidth: 960, requestId: 20, type: 'reconfigure' });
      assert.equal(harness.runTimeouts(2000), 1);
      assert.deepEqual(
        harness.parentMessages.filter((message) => message.requestId === 20).at(-1),
        { ok: false, reason: 'helper-ack-timeout', requestId: 20, type: 'reconfigured' }
      );
      assert.deepEqual(harness.children[0].killSignals, ['SIGKILL']);

      // Even if the timed-out helper reports that it applied the request while
      // termination is in flight, its late ACK cannot change the committed
      // profile used for the replacement process.
      harness.children[0].stderr.emit('data', helperAck(20, {
        fps: 15,
        maxHeight: 540,
        maxWidth: 960
      }));
      harness.exitChild(0, 0, 'SIGKILL');
      assert.deepEqual(harness.spawnCalls[1].args, [
        '--source', 'screen:1:0',
        '--fps', '15',
        '--max-height', '720',
        '--max-width', '1280'
      ]);

      harness.send({ fps: 5, requestId: 30, type: 'reconfigure' });
      harness.exitChild(1, 1);
      assert.deepEqual(
        harness.parentMessages.filter((message) => message.requestId === 30).at(-1),
        { ok: false, reason: 'helper-exited', requestId: 30, type: 'reconfigured' }
      );
      assert.equal(harness.children.length, 3);

      harness.send({ fps: 30, requestId: 40, type: 'reconfigure' });
      harness.send({ type: 'stop' });
      assert.deepEqual(
        harness.parentMessages.filter((message) => message.requestId === 40).at(-1),
        { ok: false, reason: 'session-stopped', requestId: 40, type: 'reconfigured' }
      );
    } finally {
      harness.cleanup();
    }
  });

  it('escalates an explicit stop if the helper has not exited after SIGTERM', () => {
    const harness = loadRelayHarness();
    try {
      harness.start();
      harness.send({ type: 'stop' });
      assert.deepEqual(harness.children[0].killSignals, ['SIGTERM']);
      assert.equal(harness.runTimeouts(2000), 1);
      assert.deepEqual(harness.children[0].killSignals, ['SIGTERM', 'SIGKILL']);
    } finally {
      harness.cleanup();
    }
  });

  it('cancels stop escalation when the helper exits after SIGTERM', () => {
    const harness = loadRelayHarness();
    try {
      harness.start();
      harness.send({ type: 'stop' });
      harness.exitChild(0, 0, 'SIGTERM');
      assert.equal(harness.runTimeouts(2000), 0);
      assert.deepEqual(harness.children[0].killSignals, ['SIGTERM']);
    } finally {
      harness.cleanup();
    }
  });

  it('ends explicitly when the helper process emits an error', () => {
    const harness = loadRelayHarness();
    try {
      const port = harness.start();
      harness.send({ fps: 15, requestId: 51, type: 'reconfigure' });
      harness.children[0].emit('error', new Error('spawn failure'));

      assert.deepEqual(
        harness.parentMessages.filter((message) => message.requestId === 51).at(-1),
        { ok: false, reason: 'helper-process-error', requestId: 51, type: 'reconfigured' }
      );
      assert.deepEqual(port.messages.at(-1), { reason: 'spawn-error', type: 'end' });
      assert.deepEqual(
        harness.parentMessages.filter((message) => message.type === 'exited').at(-1),
        { code: 0, reason: 'spawn-error', signal: null, type: 'exited' }
      );
      assert.equal(harness.immediateCount(), 1);
    } finally {
      harness.cleanup();
    }
  });

  it('stops restarting after the bounded crash budget is exhausted', () => {
    const harness = loadRelayHarness();
    try {
      const port = harness.start();
      for (let index = 0; index < 4; ++index) {
        harness.exitChild(index, 1);
      }

      assert.equal(harness.children.length, 4, 'initial helper plus three bounded restarts');
      assert.deepEqual(port.messages.at(-1), { reason: 'exited', type: 'end' });
      assert.deepEqual(
        harness.parentMessages.filter((message) => message.type === 'exited').at(-1),
        { code: 1, reason: 'exited', signal: null, type: 'exited' }
      );
      assert.equal(harness.immediateCount(), 1);
    } finally {
      harness.cleanup();
    }
  });

  it('does not restart an explicitly unsupported helper', () => {
    const harness = loadRelayHarness();
    try {
      const port = harness.start();
      harness.exitChild(0, 2);

      assert.equal(harness.children.length, 1);
      assert.deepEqual(port.messages.at(-1), { reason: 'unsupported', type: 'end' });
      assert.deepEqual(
        harness.parentMessages.filter((message) => message.type === 'exited').at(-1),
        { code: 2, reason: 'unsupported', signal: null, type: 'exited' }
      );
    } finally {
      harness.cleanup();
    }
  });
});
