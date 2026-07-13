'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  CHANNEL,
  configureDesktopNotificationsIpc,
  sanitizeNotificationPayload
} = require('../electron/notifications');

function createHarness({ supported = true, trusted = true } = {}) {
  const handlers = new Map();
  const notifications = [];
  const restoreCalls = [];
  class FakeNotification {
    constructor(options) {
      this.handlers = new Map();
      this.options = options;
      this.shown = false;
      notifications.push(this);
    }
    static isSupported() {
      return supported;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    show() {
      this.shown = true;
    }
    click() {
      this.handlers.get('click')?.();
    }
  }

  configureDesktopNotificationsIpc({
    Notification: FakeNotification,
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    },
    isTrustedFrame: () => trusted,
    restoreMainWindow: () => restoreCalls.push('restore')
  });

  return {
    handler: handlers.get(CHANNEL),
    notifications,
    restoreCalls
  };
}

function createEvent(url = 'https://voice.example/room') {
  return {
    senderFrame: { url }
  };
}

describe('desktop notifications bridge', () => {
  it('sanitizes only supported string fields and omits icon data', () => {
    const payload = {
      body: ` body\n${'b'.repeat(600)}`,
      dedupeKey: 'd'.repeat(200),
      icon: 'file:///unsafe.png',
      route: ' /room/123\t ',
      tag: 'tag\u0000value',
      title: ` title\n${'t'.repeat(200)}`,
      unknown: 'drop'
    };

    const sanitized = sanitizeNotificationPayload(payload);

    assert.deepEqual(Object.keys(sanitized).sort(), ['body', 'dedupeKey', 'route', 'tag', 'title']);
    assert.equal(sanitized.title.length, 120);
    assert.equal(sanitized.body.length, 512);
    assert.equal(sanitized.tag, 'tagvalue');
    assert.equal(sanitized.dedupeKey.length, 128);
    assert.equal(sanitized.route, '/room/123');
    assert.equal('icon' in sanitized, false);
  });

  it('rejects untrusted renderer frames before creating notifications', () => {
    const { handler, notifications } = createHarness({ trusted: false });

    assert.throws(
      () => handler(createEvent('https://evil.example'), { title: 'Hi' }),
      /Desktop notifications are only available for the configured Voice Room URL\./
    );
    assert.equal(notifications.length, 0);
  });

  it('returns unsupported without throwing when native notifications are unavailable', () => {
    const { handler, notifications } = createHarness({ supported: false });

    assert.deepEqual(handler(createEvent(), { title: 'Hi' }), { ok: false, reason: 'unsupported' });
    assert.equal(notifications.length, 0);
  });

  it('creates supported notifications with sanitized title/body only', () => {
    const { handler, notifications } = createHarness();

    assert.deepEqual(handler(createEvent(), {
      body: `Body${'b'.repeat(600)}`,
      icon: 'file:///unsafe.png',
      route: '/room/1',
      title: `Title${'t'.repeat(200)}`
    }), { ok: true });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].shown, true);
    assert.deepEqual(Object.keys(notifications[0].options).sort(), ['body', 'title']);
    assert.equal(notifications[0].options.title.length, 120);
    assert.equal(notifications[0].options.body.length, 512);
  });

  it('restores the main window on notification click', () => {
    const { handler, notifications, restoreCalls } = createHarness();

    handler(createEvent(), { body: 'Body', title: 'Title' });
    notifications[0].click();

    assert.deepEqual(restoreCalls, ['restore']);
  });
});
