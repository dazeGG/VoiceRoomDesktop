'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { describe, it } = require('node:test');

class FakeChild extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.exitCode = null;
    this.killed = false;
    this.killSignals = [];
    this.stderr = new EventEmitter();
    this.stdout = new EventEmitter();
  }

  kill(signal) {
    this.killSignals.push(signal);
    this.killed = true;
    return true;
  }

  exit(code, signal = null) {
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
}

class FakeSender extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  isDestroyed() {
    return false;
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
}

function loadAudioHarness() {
  const originalLoad = Module._load;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const modulePath = require.resolve('../electron/native/audio');
  const children = [];
  const timeouts = new Set();

  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() { return this; } };
    timeouts.add(timer);
    return timer;
  };
  global.clearTimeout = (timer) => timeouts.delete(timer);
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  delete require.cache[modulePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return { app: { getAppPath: () => 'C:\\VoiceRoom', on() {} } };
    if (request === 'node:child_process') {
      return {
        spawn(command, args) {
          const child = new FakeChild(args);
          children.push(child);
          return child;
        }
      };
    }
    if (request === 'node:fs') {
      return { accessSync() {}, constants: { X_OK: 1 }, existsSync: () => true };
    }
    if (request === '../logger') return { error() {}, info() {}, warn() {} };
    return originalLoad.call(this, request, parent, isMain);
  };

  const cleanup = () => {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    Object.defineProperty(process, 'platform', platformDescriptor);
    delete require.cache[modulePath];
  };

  try {
    const audio = require('../electron/native/audio');
    return {
      audio,
      children,
      cleanup,
      runTimeouts(delay) {
        const due = [...timeouts].filter((timer) => timer.delay === delay);
        for (const timer of due) {
          timeouts.delete(timer);
          timer.callback();
        }
        return due.length;
      }
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

const events = (sender) => sender.sent
  .filter((item) => item.channel === 'desktop-audio:event')
  .map((item) => item.payload.event.event);

describe('native stream audio helper restarts', { concurrency: false }, () => {
  it('restarts a crashed helper under the same session and keeps forwarding audio', () => {
    const harness = loadAudioHarness();
    try {
      const sender = new FakeSender();
      const { sessionId } = harness.audio.startSafeSystemAudioCapture(sender);
      harness.children[0].stdout.emit('data', Buffer.alloc(16));
      harness.children[0].exit(3);

      assert.equal(harness.children.length, 1, 'the restart is scheduled, not immediate');
      assert.deepEqual(events(sender), ['restarting']);
      assert.equal(harness.audio.getNativeAudioState().restarting, true);
      assert.equal(harness.runTimeouts(0), 1);
      assert.equal(harness.children.length, 2);
      assert.deepEqual(harness.children[1].args, harness.children[0].args);

      harness.children[1].stdout.emit('data', Buffer.alloc(8));
      const data = sender.sent.filter((item) => item.channel === 'desktop-audio:data');
      assert.equal(data.length, 2);
      assert.ok(data.every((item) => item.payload.sessionId === sessionId));
      assert.deepEqual(harness.audio.getNativeAudioState(), {
        active: true,
        restarting: false,
        restarts: 1,
        target: 'system'
      });
    } finally {
      harness.cleanup();
    }
  });

  it('does not restart after a clean exit or an explicit stop', () => {
    const harness = loadAudioHarness();
    try {
      const sender = new FakeSender();
      harness.audio.startSafeSystemAudioCapture(sender);
      harness.children[0].exit(0);
      assert.deepEqual(events(sender), ['exit']);

      const { sessionId } = harness.audio.startSafeSystemAudioCapture(sender);
      harness.audio.stopSafeSystemAudioCapture(sessionId);
      assert.deepEqual(harness.children[1].killSignals, ['SIGTERM']);
      harness.children[1].exit(null, 'SIGTERM');
      assert.equal(harness.runTimeouts(0), 0);
      assert.equal(harness.children.length, 2);
      assert.equal(harness.audio.getNativeAudioState().active, false);
    } finally {
      harness.cleanup();
    }
  });

  it('gives up after the restart budget and reports the exit', () => {
    const harness = loadAudioHarness();
    try {
      const sender = new FakeSender();
      harness.audio.startSafeSystemAudioCapture(sender);
      const pauses = [0, 0, 0, 1000, 2000, 5000, 10000, 15000, 30000];
      for (const pause of pauses) {
        harness.children.at(-1).exit(3);
        assert.equal(harness.runTimeouts(pause), 1);
      }
      harness.children.at(-1).exit(3);

      assert.equal(harness.children.length, 10);
      assert.equal(events(sender).at(-1), 'exit');
      assert.deepEqual(harness.audio.getNativeAudioState(), {
        active: false,
        lastExitCode: 3,
        restarts: 9,
        target: 'system'
      });
    } finally {
      harness.cleanup();
    }
  });

  it('targets one app window only when the shell asks for it', () => {
    const harness = loadAudioHarness();
    try {
      assert.deepEqual(
        harness.audio.getSafeSystemAudioHelperArgs({ targetWindow: 4242 }),
        ['--target-pid', String(process.pid), '--target-window', '4242']
      );
      assert.deepEqual(
        harness.audio.getSafeSystemAudioHelperArgs({ targetWindow: 'x' }),
        ['--target-pid', String(process.pid)]
      );
    } finally {
      harness.cleanup();
    }
  });
});
