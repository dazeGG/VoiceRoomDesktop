'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  CHANNEL,
  configureDesktopNotificationsIpc,
  notificationsByTag,
  sanitizeNotificationPayload
} = require('../electron/notifications');

function createHarness({ emitShow = true, failMessage = '', supported = true, trusted = true } = {}) {
  const handlers = new Map();
  const notifications = [];
  const restoreCalls = [];
  const routes = [];
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
      if (failMessage) {
        this.handlers.get('failed')?.({}, failMessage);
        return;
      }
      if (emitShow) this.handlers.get('show')?.();
    }
    click() {
      this.handlers.get('click')?.();
    }
    close() {
      this.closed = true;
      this.handlers.get('close')?.();
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
    openRoute: (route) => routes.push(route),
    restoreMainWindow: () => restoreCalls.push('restore')
  });

  return {
    handler: handlers.get(CHANNEL),
    notifications,
    restoreCalls,
    routes
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

  it('returns unsupported without throwing when native notifications are unavailable', async () => {
    const { handler, notifications } = createHarness({ supported: false });

    assert.deepEqual(await handler(createEvent(), { title: 'Hi' }), { ok: false, reason: 'unsupported' });
    assert.equal(notifications.length, 0);
  });

  it('creates silent notifications so the OS sound never doubles the app cue', async () => {
    const { handler, notifications } = createHarness();

    await handler(createEvent(), { body: 'Body', title: 'Title' });

    assert.equal(notifications[0].options.silent, true);
  });

  it('creates supported notifications with sanitized title/body only', async () => {
    const { handler, notifications } = createHarness();

    assert.deepEqual(await handler(createEvent(), {
      body: `Body${'b'.repeat(600)}`,
      icon: 'file:///unsafe.png',
      route: '/room/1',
      title: `Title${'t'.repeat(200)}`
    }), { ok: true });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].shown, true);
    assert.deepEqual(Object.keys(notifications[0].options).sort(), ['body', 'silent', 'title']);
    assert.equal(notifications[0].options.title.length, 120);
    assert.equal(notifications[0].options.body.length, 512);
  });

  it('reports native notification failures instead of a false success', async () => {
    const { handler, notifications } = createHarness({ failMessage: 'Notifications are not allowed' });

    assert.deepEqual(await handler(createEvent(), { title: 'Hi' }), {
      ok: false,
      reason: 'failed',
      error: 'Notifications are not allowed'
    });
    assert.equal(notifications.length, 1);
  });

  it('restores the main window on notification click', async () => {
    const { handler, notifications, restoreCalls } = createHarness();

    await handler(createEvent(), { body: 'Body', title: 'Title' });
    notifications[0].click();

    assert.deepEqual(restoreCalls, ['restore']);
  });

  it('opens the notification route on click instead of only restoring the window', async () => {
    const { handler, notifications, restoreCalls, routes } = createHarness();

    await handler(createEvent(), { route: '/?dm=user-1', title: 'Alice' });
    notifications[0].click();

    assert.deepEqual(routes, ['/?dm=user-1']);
    assert.deepEqual(restoreCalls, []);
  });

  it('replaces the previous notification with the same tag', async () => {
    const { handler, notifications } = createHarness();

    await handler(createEvent(), { tag: 'dm:replace-1', title: 'First' });
    await handler(createEvent(), { tag: 'dm:replace-2', title: 'Other chat' });
    await handler(createEvent(), { tag: 'dm:replace-1', title: 'Second' });

    assert.equal(notifications[0].closed, true);
    assert.equal(notifications[1].closed, undefined);
    assert.equal(notifications[2].closed, undefined);
    assert.equal(notificationsByTag.get('dm:replace-1'), notifications[2]);

    notifications[2].click();
    assert.equal(notificationsByTag.has('dm:replace-1'), false);
    notifications[1].close();
    assert.equal(notificationsByTag.has('dm:replace-2'), false);
  });
});
