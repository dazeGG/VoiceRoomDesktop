'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
  OPEN_CHANNEL,
  READY_CHANNEL,
  SUBSCRIBE_GRACE_MS,
  createDeepLinkController,
  findDeepLinkArgument,
  parseDeepLink,
  resolveAppRouteUrl,
  resolveProtocolRegistration,
  resolveProtocolScheme
} = require('../electron/deep-links');

describe('deep link parsing', () => {
  it('uses the stable scheme only for packaged release builds', () => {
    assert.equal(resolveProtocolScheme({ isPackaged: true, buildProfile: { channel: 'release' } }), 'voiceroom');
    assert.equal(resolveProtocolScheme({ isPackaged: true, buildProfile: null }), 'voiceroom');
    assert.equal(resolveProtocolScheme({ isPackaged: true, buildProfile: { channel: 'dev' } }), 'voiceroom-dev');
    assert.equal(resolveProtocolScheme({ isPackaged: false }), 'voiceroom-dev');
  });

  it('parses room links in the forms operating systems hand over', () => {
    const room = { kind: 'room', roomId: 'Abc_12-x', route: '/r/Abc_12-x' };
    assert.deepEqual(parseDeepLink('voiceroom://r/Abc_12-x'), room);
    assert.deepEqual(parseDeepLink('voiceroom://r/Abc_12-x/'), room);
    assert.deepEqual(parseDeepLink('voiceroom:///r/Abc_12-x'), room);
    assert.deepEqual(parseDeepLink('  voiceroom://r/Abc_12-x  '), room);
  });

  it('parses mention, direct message and bare app links', () => {
    assert.deepEqual(parseDeepLink('voiceroom://?room=abc123&message=m_42'), {
      kind: 'mention', messageId: 'm_42', roomId: 'abc123', route: '/?room=abc123&message=m_42'
    });
    assert.deepEqual(parseDeepLink('voiceroom://?dm=dm-7'), { dmId: 'dm-7', kind: 'dm', route: '/?dm=dm-7' });
    assert.deepEqual(parseDeepLink('voiceroom://'), { kind: 'app', route: '/' });
    assert.deepEqual(parseDeepLink('voiceroom-dev://r/abc123', 'voiceroom-dev'), { kind: 'room', roomId: 'abc123', route: '/r/abc123' });
  });

  it('rejects anything else', () => {
    for (const value of [
      undefined,
      '',
      'not a url',
      'https://voiceroom.ru/r/abc123',
      'voiceroom-dev://r/abc123',
      'voiceroom://r/ab',
      'voiceroom://r/abc123/extra',
      'voiceroom://r/abc%2F123',
      'voiceroom://settings',
      'voiceroom://?room=abc123',
      'voiceroom://?message=m1',
      'voiceroom://?room=abc123&message=bad%20id',
      'voiceroom://?dm=',
      `voiceroom://r/${'a'.repeat(3000)}`
    ]) {
      assert.equal(parseDeepLink(value), null, String(value));
    }
  });

  it('finds the link among launch arguments', () => {
    assert.equal(findDeepLinkArgument(['app.exe', '--hidden', 'voiceroom://r/abc123']), 'voiceroom://r/abc123');
    assert.equal(findDeepLinkArgument(['app.exe', 'VoiceRoom://r/abc123']), 'VoiceRoom://r/abc123');
    assert.equal(findDeepLinkArgument(['app.exe', 'voiceroom-dev://r/abc123']), '');
    assert.equal(findDeepLinkArgument(null), '');
  });

  it('keeps routes on the configured origin', () => {
    assert.equal(resolveAppRouteUrl('https://voiceroom.ru', '/r/abc123'), 'https://voiceroom.ru/r/abc123');
    assert.equal(resolveAppRouteUrl('https://voiceroom.ru/', '/?dm=x1'), 'https://voiceroom.ru/?dm=x1');
    assert.equal(resolveAppRouteUrl('https://voiceroom.ru', '//evil.example/r/abc123'), 'https://voiceroom.ru/');
    assert.equal(resolveAppRouteUrl('', '/r/abc123'), '');
  });
});

describe('protocol registration policy', () => {
  it('registers installed builds unconditionally', () => {
    assert.deepEqual(resolveProtocolRegistration({ isPackaged: true, platform: 'win32', env: {} }), { register: true });
    assert.deepEqual(resolveProtocolRegistration({ isPackaged: true, platform: 'darwin', env: {}, isClaimed: true }), { register: true });
  });

  it('lets the portable build take only an unclaimed protocol, pointing at the original exe', () => {
    const env = { PORTABLE_EXECUTABLE_FILE: 'D:/Voice-Room.exe' };
    assert.deepEqual(resolveProtocolRegistration({ isPackaged: true, platform: 'win32', env, isClaimed: false }), {
      args: [], path: 'D:/Voice-Room.exe', register: true
    });
    assert.deepEqual(resolveProtocolRegistration({ isPackaged: true, platform: 'win32', env, isClaimed: true }), {
      reason: 'claimed', register: false
    });
  });

  it('registers unpackaged runs against electron and the app entry', () => {
    assert.deepEqual(resolveProtocolRegistration({ appEntry: 'C:/repo', execPath: 'C:/electron.exe', isPackaged: false, platform: 'win32' }), {
      args: ['C:/repo'], path: 'C:/electron.exe', register: true
    });
  });
});

class FakeWebContents extends EventEmitter {
  constructor({ loading = false } = {}) {
    super();
    this.loading = loading;
    this.sent = [];
  }

  isLoading() { return this.loading; }
  send(channel, payload) { this.sent.push([channel, payload]); }
}

class FakeWindow {
  constructor(options) {
    this.destroyed = false;
    this.loaded = [];
    this.webContents = new FakeWebContents(options);
  }

  isDestroyed() { return this.destroyed; }
  loadURL(url) {
    this.loaded.push(url);
    return Promise.resolve();
  }
}

function createHarness({
  claimedBy = '',
  dialogResponse = 0,
  isPackaged = true,
  voiceActive = false,
  window = null
} = {}) {
  const handlers = new Map();
  const registrations = [];
  const restores = [];
  const missing = [];
  const dialogs = [];
  const timers = [];
  let clock = 1000;
  const state = { window };
  const controller = createDeepLinkController({
    app: {
      getApplicationNameForProtocol: () => claimedBy,
      isPackaged,
      setAsDefaultProtocolClient: (...args) => {
        registrations.push(args);
        return true;
      }
    },
    appUrl: 'https://voiceroom.ru',
    clearTimeout: (timer) => { timer.cancelled = true; },
    dialog: {
      showMessageBox: async (_window, options) => {
        dialogs.push(options);
        return { response: dialogResponse };
      }
    },
    env: {},
    getMainWindow: () => state.window,
    isTrustedFrame: (frame) => frame?.trusted !== false,
    isVoiceActive: () => voiceActive,
    log: { info() {}, warn() {} },
    now: () => clock,
    onWindowMissing: () => missing.push(true),
    platform: 'win32',
    restoreMainWindow: () => restores.push(true),
    scheme: 'voiceroom',
    setTimeout: (callback, delay) => {
      const timer = { callback, cancelled: false, delay };
      timers.push(timer);
      return timer;
    }
  });
  controller.configureIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } });
  return {
    advance: (ms) => { clock += ms; },
    controller,
    dialogs,
    fireTimers: () => timers.filter((timer) => !timer.cancelled).forEach((timer) => { timer.cancelled = true; timer.callback(); }),
    missing,
    ready: (webContents, frame = { trusted: true }) => handlers.get(READY_CHANNEL)({ sender: webContents, senderFrame: frame }),
    registrations,
    restores,
    state,
    timers
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('deep link controller', () => {
  it('opens a launch link as the initial page and never starts hidden for it', () => {
    const harness = createHarness();
    assert.equal(harness.controller.hasInitialLink(), false);
    harness.controller.captureInitialArgv(['app.exe', '--hidden', 'voiceroom://r/abc123']);

    assert.equal(harness.controller.hasInitialLink(), true);
    assert.equal(harness.controller.takeInitialUrl(), 'https://voiceroom.ru/r/abc123');
    assert.equal(harness.controller.takeInitialUrl(), 'https://voiceroom.ru/', 'the link is consumed once');
  });

  it('keeps a link that arrives before the window exists for the upcoming launch', () => {
    const harness = createHarness();
    harness.controller.handleUrl('voiceroom://?dm=dm1');

    assert.deepEqual(harness.missing, [true]);
    assert.equal(harness.controller.takeInitialUrl(), 'https://voiceroom.ru/?dm=dm1');
  });

  it('delivers to a subscribed page and focuses the window', () => {
    const window = new FakeWindow();
    const harness = createHarness({ window });
    harness.controller.attachWindow(window);
    assert.deepEqual(harness.ready(window.webContents), { ok: true, scheme: 'voiceroom' });

    harness.controller.handleArgv(['app.exe', 'voiceroom://r/abc123']);

    assert.deepEqual(window.webContents.sent, [[OPEN_CHANNEL, { kind: 'room', roomId: 'abc123', route: '/r/abc123' }]]);
    assert.deepEqual(harness.restores, [true]);
    assert.deepEqual(window.loaded, []);
  });

  it('holds a link while the page loads and hands it over on subscription', () => {
    const window = new FakeWindow({ loading: true });
    const harness = createHarness({ window });
    harness.controller.attachWindow(window);

    harness.controller.handleUrl('voiceroom://r/abc123');
    assert.equal(harness.timers.length, 0, 'no grace timer until the page has loaded');

    window.webContents.loading = false;
    window.webContents.emit('did-finish-load');
    assert.equal(harness.timers.at(-1).delay, SUBSCRIBE_GRACE_MS);

    harness.ready(window.webContents);
    assert.deepEqual(window.webContents.sent.map(([channel]) => channel), [OPEN_CHANNEL]);
    assert.equal(harness.timers.at(-1).cancelled, true);
    harness.fireTimers();
    assert.deepEqual(window.loaded, []);
  });

  it('navigates an older web client that never subscribes when no call is active', async () => {
    const window = new FakeWindow();
    const harness = createHarness({ window });
    harness.controller.attachWindow(window);

    harness.controller.handleUrl('voiceroom://?room=abc123&message=m1');
    assert.equal(harness.timers.at(-1).delay, 0, 'a long-loaded page gets no extra grace');
    harness.fireTimers();
    await flush();

    assert.deepEqual(window.loaded, ['https://voiceroom.ru/?room=abc123&message=m1']);
    assert.deepEqual(harness.dialogs, []);
  });

  it('waits only the rest of the grace period for a page that loaded recently', () => {
    const window = new FakeWindow({ loading: true });
    const harness = createHarness({ window });
    harness.controller.attachWindow(window);
    window.webContents.loading = false;
    window.webContents.emit('did-finish-load');
    harness.advance(2000);

    harness.controller.handleUrl('voiceroom://r/abc123');
    assert.equal(harness.timers.at(-1).delay, SUBSCRIBE_GRACE_MS - 2000);
  });

  it('asks before an older web client leaves an active call', async () => {
    for (const [response, expected] of [[0, ['https://voiceroom.ru/r/abc123']], [1, []]]) {
      const window = new FakeWindow();
      const harness = createHarness({ dialogResponse: response, voiceActive: true, window });
      harness.controller.attachWindow(window);

      harness.controller.handleUrl('voiceroom://r/abc123');
      harness.fireTimers();
      await flush();

      assert.equal(harness.dialogs.length, 1);
      assert.deepEqual(harness.dialogs[0].buttons, ['Перейти', 'Отмена']);
      assert.deepEqual(window.loaded, expected);
    }
  });

  it('requires a new subscription after a full navigation', async () => {
    const window = new FakeWindow();
    const harness = createHarness({ window });
    harness.controller.attachWindow(window);
    harness.ready(window.webContents);

    window.webContents.emit('did-navigate');
    window.webContents.loading = true;
    harness.controller.handleUrl('voiceroom://r/abc123');
    assert.deepEqual(window.webContents.sent, []);

    harness.ready(window.webContents);
    assert.deepEqual(window.webContents.sent.map(([channel]) => channel), [OPEN_CHANNEL]);
  });

  it('only focuses the window for an unsupported link', () => {
    const window = new FakeWindow();
    const harness = createHarness({ window });
    harness.controller.handleUrl('voiceroom://settings/secret');

    assert.deepEqual(harness.restores, [true]);
    assert.deepEqual(window.webContents.sent, []);
    assert.equal(harness.timers.length, 0);
  });

  it('rejects untrusted subscriptions', () => {
    const harness = createHarness();
    assert.throws(
      () => harness.ready(new FakeWebContents(), { trusted: false }),
      /Desktop links are only available for the configured Voice Room URL\./
    );
  });

  it('registers the protocol for installed builds and leaves a claimed one to the installer', () => {
    const installed = createHarness();
    assert.equal(installed.controller.registerProtocol(), true);
    assert.deepEqual(installed.registrations, [['voiceroom']]);
  });
});
