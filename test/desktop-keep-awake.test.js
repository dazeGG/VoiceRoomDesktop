'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const { createKeepAwakeController } = require('../electron/keep-awake');

function createPowerSaveBlocker() {
  let nextId = 1;
  const started = new Set();
  const calls = [];
  return {
    calls,
    isStarted: (id) => started.has(id),
    start(type) {
      const id = nextId++;
      calls.push(['start', type, id]);
      started.add(id);
      return id;
    },
    stop(id) {
      calls.push(['stop', id]);
      started.delete(id);
    }
  };
}

describe('keep-awake controller', () => {
  it('prevents display sleep only while voice is active', () => {
    const blocker = createPowerSaveBlocker();
    const controller = createKeepAwakeController({ powerSaveBlocker: blocker, log: { warn() {} } });

    controller.setVoiceActive(true);
    controller.setVoiceActive(true);
    assert.equal(controller.isBlocking(), true);

    controller.setVoiceActive(false);
    controller.setVoiceActive(false);
    assert.equal(controller.isBlocking(), false);

    assert.deepEqual(blocker.calls, [
      ['start', 'prevent-display-sleep', 1],
      ['stop', 1]
    ]);
  });

  it('releases the blocker while the screen is locked and restores it on unlock', () => {
    const blocker = createPowerSaveBlocker();
    const powerMonitor = new EventEmitter();
    const controller = createKeepAwakeController({ powerSaveBlocker: blocker, log: { warn() {} } });
    controller.installPowerMonitor(powerMonitor);

    controller.setVoiceActive(true);
    powerMonitor.emit('lock-screen');
    assert.equal(controller.isBlocking(), false);

    powerMonitor.emit('unlock-screen');
    assert.equal(controller.isBlocking(), true);

    powerMonitor.emit('lock-screen');
    controller.setVoiceActive(false);
    powerMonitor.emit('unlock-screen');
    assert.equal(controller.isBlocking(), false);
    assert.deepEqual(blocker.calls.map(([kind]) => kind), ['start', 'stop', 'start', 'stop']);
  });

  it('dispose releases the blocker and detaches power monitor listeners', () => {
    const blocker = createPowerSaveBlocker();
    const powerMonitor = new EventEmitter();
    const controller = createKeepAwakeController({ powerSaveBlocker: blocker, log: { warn() {} } });
    controller.installPowerMonitor(powerMonitor);
    controller.setVoiceActive(true);

    controller.dispose();

    assert.equal(controller.isBlocking(), false);
    assert.equal(powerMonitor.listenerCount('lock-screen'), 0);
    assert.equal(powerMonitor.listenerCount('unlock-screen'), 0);
  });

  it('survives a blocker that throws on start', () => {
    const warnings = [];
    const controller = createKeepAwakeController({
      powerSaveBlocker: {
        isStarted: () => false,
        start() {
          throw new Error('no power service');
        },
        stop() {}
      },
      log: { warn: (...args) => warnings.push(args) }
    });

    controller.setVoiceActive(true);

    assert.equal(controller.isBlocking(), false);
    assert.equal(warnings.length, 1);
  });
});
