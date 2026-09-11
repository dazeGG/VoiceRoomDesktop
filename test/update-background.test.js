'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
  APPLY_QUIET_MS,
  CHECK_INTERVAL_MS,
  PENDING_UPDATE_CHECK_DELAY_MS,
  RESUME_CHECK_DELAY_MS,
  RETRY_AFTER_FAILED_CHECK_MS,
  createBackgroundUpdateController
} = require('../electron/policies/update-background');

function createClock() {
  let current = 1_000_000;
  let nextId = 1;
  const pending = new Map();

  function schedule(fn, ms, repeat) {
    const id = nextId++;
    pending.set(id, { at: current + ms, fn, ms, repeat });
    return id;
  }

  return {
    now: () => current,
    timers: {
      clearInterval: (id) => pending.delete(id),
      clearTimeout: (id) => pending.delete(id),
      setInterval: (fn, ms) => schedule(fn, ms, true),
      setTimeout: (fn, ms) => schedule(fn, ms, false)
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let dueId = null;
        let due = null;
        for (const [id, timer] of pending) {
          if (timer.at <= target && (!due || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (!due) break;
        current = due.at;
        if (due.repeat) due.at += due.ms;
        else pending.delete(dueId);
        due.fn();
      }
      current = target;
    },
    jump(ms) {
      current += ms;
    }
  };
}

function createUpdater({ available = true, checkError = null } = {}) {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.downloads = 0;
  updater.installs = [];
  updater.checkForUpdates = async () => {
    updater.checks += 1;
    if (checkError) throw checkError;
    updater.emit(available ? 'update-available' : 'update-not-available', { version: '1.3.0' });
  };
  updater.downloadUpdate = async () => {
    updater.downloads += 1;
    updater.emit('update-downloaded', { version: '1.3.0' });
  };
  updater.quitAndInstall = (...args) => updater.installs.push(args);
  return updater;
}

async function flush() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createHarness(options = {}) {
  const clock = createClock();
  const updater = options.updater || createUpdater();
  const env = { voiceActive: false, windowVisible: false };
  const events = [];
  const controller = createBackgroundUpdateController({
    autoUpdater: updater,
    beforeInstall: (payload) => events.push(['beforeInstall', payload, updater.installs.length]),
    isMainWindowVisible: () => env.windowVisible,
    isVoiceActive: () => env.voiceActive,
    log: { info() {}, warn() {} },
    now: clock.now,
    onStateChange: (state) => events.push(['state', state.phase, state.version]),
    timers: clock.timers
  });
  return { clock, controller, env, events, updater };
}

describe('background update controller', () => {
  it('checks once per interval after the startup gate and configures install on quit', async () => {
    const { clock, controller, updater } = createHarness({ updater: createUpdater({ available: false }) });
    controller.start();

    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, true);

    clock.advance(CHECK_INTERVAL_MS - 1);
    await flush();
    assert.equal(updater.checks, 0);

    clock.advance(1);
    await flush();
    assert.equal(updater.checks, 1);
    assert.deepEqual(controller.getState(), { phase: 'idle', version: '' });

    clock.advance(CHECK_INTERVAL_MS);
    await flush();
    assert.equal(updater.checks, 2);
  });

  it('starts sooner after a failed or deferred startup check', async () => {
    const failed = createHarness({ updater: createUpdater({ available: false }) });
    failed.controller.start({ lastCheckFailed: true });
    failed.clock.advance(RETRY_AFTER_FAILED_CHECK_MS);
    await flush();
    assert.equal(failed.updater.checks, 1);

    const pending = createHarness();
    pending.controller.start({ updatePending: true });
    pending.clock.advance(PENDING_UPDATE_CHECK_DELAY_MS);
    await flush();
    assert.equal(pending.updater.checks, 1);
    assert.equal(pending.updater.downloads, 1);
  });

  it('downloads silently and exposes the ready version', async () => {
    const { clock, controller, env, events, updater } = createHarness();
    env.windowVisible = true;
    controller.start();

    clock.advance(CHECK_INTERVAL_MS);
    await flush();

    assert.equal(updater.downloads, 1);
    assert.deepEqual(controller.getState(), { phase: 'ready', version: '1.3.0' });
    assert.deepEqual(events.filter(([kind]) => kind === 'state').map(([, phase]) => phase), [
      'checking',
      'downloading',
      'ready'
    ]);

    clock.advance(CHECK_INTERVAL_MS);
    await flush();
    assert.equal(updater.checks, 1, 'a downloaded update is not checked again');
    assert.deepEqual(updater.installs, []);
  });

  it('installs a ready update only after the app stays in the tray without voice', async () => {
    const { clock, controller, env, events, updater } = createHarness();
    env.windowVisible = true;
    controller.start({ updatePending: true });
    clock.advance(PENDING_UPDATE_CHECK_DELAY_MS);
    await flush();

    clock.advance(APPLY_QUIET_MS * 3);
    assert.deepEqual(updater.installs, [], 'visible window defers install');

    env.windowVisible = false;
    env.voiceActive = true;
    clock.advance(APPLY_QUIET_MS * 3);
    assert.deepEqual(updater.installs, [], 'active voice defers install');

    env.voiceActive = false;
    clock.advance(APPLY_QUIET_MS - 60_000);
    assert.deepEqual(updater.installs, []);

    env.windowVisible = true;
    clock.advance(60_000);
    env.windowVisible = false;
    clock.advance(APPLY_QUIET_MS - 60_000);
    assert.deepEqual(updater.installs, [], 'showing the window restarts the quiet period');

    clock.advance(APPLY_QUIET_MS);
    assert.deepEqual(updater.installs, [[true, true]]);
    assert.deepEqual(events.find(([kind]) => kind === 'beforeInstall'), ['beforeInstall', { startHidden: true }, 0]);

    clock.advance(APPLY_QUIET_MS);
    assert.equal(updater.installs.length, 1);
  });

  it('installs immediately on explicit request and relaunches visibly', async () => {
    const { clock, controller, env, events, updater } = createHarness();
    env.windowVisible = true;
    assert.equal(controller.installNow(), false, 'nothing to install yet');

    controller.start({ updatePending: true });
    clock.advance(PENDING_UPDATE_CHECK_DELAY_MS);
    await flush();

    assert.equal(controller.installNow({ startHidden: false }), true);
    assert.equal(controller.installNow({ startHidden: false }), false);
    assert.deepEqual(updater.installs, [[true, true]]);
    assert.deepEqual(events.find(([kind]) => kind === 'beforeInstall')[1], { startHidden: false });
  });

  it('retries a failed background check sooner without surfacing it', async () => {
    const { clock, controller, updater } = createHarness({
      updater: createUpdater({ checkError: new Error('offline') })
    });
    controller.start();

    clock.advance(CHECK_INTERVAL_MS);
    await flush();
    assert.equal(updater.checks, 1);
    assert.equal(controller.getState().phase, 'idle');

    clock.advance(RETRY_AFTER_FAILED_CHECK_MS);
    await flush();
    assert.equal(updater.checks, 2);
  });

  it('checks after system resume once the interval has elapsed', async () => {
    const { clock, controller, updater } = createHarness({ updater: createUpdater({ available: false }) });
    const powerMonitor = new EventEmitter();
    controller.installPowerMonitor(powerMonitor);
    controller.start();

    powerMonitor.emit('resume');
    clock.advance(RESUME_CHECK_DELAY_MS);
    await flush();
    assert.equal(updater.checks, 0, 'a recent check is not repeated on resume');

    clock.jump(CHECK_INTERVAL_MS);
    powerMonitor.emit('resume');
    clock.advance(RESUME_CHECK_DELAY_MS);
    await flush();
    assert.equal(updater.checks, 1);
  });

  it('dispose detaches updater and power monitor listeners', () => {
    const { controller, updater } = createHarness();
    const powerMonitor = new EventEmitter();
    controller.installPowerMonitor(powerMonitor);
    controller.start();

    controller.dispose();

    for (const eventName of ['update-available', 'update-not-available', 'update-downloaded', 'error']) {
      assert.equal(updater.listenerCount(eventName), 0, eventName);
    }
    assert.equal(powerMonitor.listenerCount('resume'), 0);
  });
});
