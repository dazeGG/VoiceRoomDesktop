'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  CHANNEL,
  configureDesktopIdleIpc
} = require('../electron/idle');

function createHarness({ idleTime = 0, trusted = true } = {}) {
  const handlers = new Map();
  configureDesktopIdleIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    },
    isTrustedFrame: () => trusted,
    powerMonitor: {
      getSystemIdleTime: () => idleTime
    }
  });

  return handlers.get(CHANNEL);
}

function createEvent(url = 'https://voice.example/room') {
  return {
    senderFrame: { url }
  };
}

describe('desktop idle bridge', () => {
  it('returns the OS idle time for a trusted renderer frame', () => {
    const handler = createHarness({ idleTime: 321 });

    assert.equal(handler(createEvent()), 321);
  });

  it('rejects untrusted renderer frames before reading the OS idle time', () => {
    let reads = 0;
    const handlers = new Map();
    configureDesktopIdleIpc({
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        }
      },
      isTrustedFrame: () => false,
      powerMonitor: {
        getSystemIdleTime() {
          reads += 1;
          return 10;
        }
      }
    });

    assert.throws(
      () => handlers.get(CHANNEL)(createEvent('https://evil.example')),
      /Desktop idle time is only available for the configured Voice Room URL\./
    );
    assert.equal(reads, 0);
  });

  it('fails closed when Electron returns an invalid idle time', () => {
    const handler = createHarness({ idleTime: Number.NaN });

    assert.throws(
      () => handler(createEvent()),
      /System idle time is unavailable\./
    );
  });
});
