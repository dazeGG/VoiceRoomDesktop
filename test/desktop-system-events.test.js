'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  GET_STATE_CHANNEL,
  STATE_CHANNEL,
  WAKE_CHANNEL,
  createSystemEventsController
} = require('../electron/system-events');
const { createBackgroundThrottlingController } = require('../electron/window/background-throttling');

const quietLog = { info() {}, warn() {} };

function fakeWindow(url = 'https://voiceroom.ru/') {
  const window = new EventEmitter();
  window.destroyed = false;
  window.visible = true;
  window.minimized = false;
  window.bounds = { height: 600, width: 800, x: 120, y: 80 };
  window.getBounds = () => window.bounds;
  window.isDestroyed = () => window.destroyed;
  window.isVisible = () => window.visible;
  window.isMinimized = () => window.minimized;
  window.webContents = {
    destroyed: false,
    sent: [],
    throttling: [],
    url,
    getURL() { return this.url; },
    isDestroyed() { return this.destroyed; },
    send(channel, payload) { this.sent.push([channel, payload]); },
    setBackgroundThrottling(allowed) { this.throttling.push(allowed); }
  };
  return window;
}

const isTrustedUrl = (url) => url.startsWith('https://voiceroom.ru/');

test('game mode changes reach the hosted page once per change', () => {
  const events = createSystemEventsController({ isTrustedUrl, log: quietLog });
  const window = fakeWindow();
  events.attachWindow(window);

  events.setGameMode(true);
  events.setGameMode(true);
  events.setGameMode(false);
  assert.deepEqual(window.webContents.sent, [
    [STATE_CHANNEL, { gameMode: true, windowCovered: false, windowVisible: true }],
    [STATE_CHANNEL, { gameMode: false, windowCovered: false, windowVisible: true }]
  ]);
  assert.deepEqual(events.getState(), { gameMode: false, windowCovered: false, windowVisible: true });
});

test('window coverage follows game bounds and main window movement and resizing', () => {
  const events = createSystemEventsController({ isTrustedUrl, log: quietLog });
  const window = fakeWindow();
  const gameBounds = { height: 900, width: 1000, x: 0, y: 0 };
  events.attachWindow(window);
  assert.deepEqual(events.getState(), { gameMode: false, windowCovered: false, windowVisible: true });

  events.setGameMode(true, gameBounds);
  assert.deepEqual(events.getState(), { gameMode: true, windowCovered: true, windowVisible: true });

  window.bounds = { ...window.bounds, x: 1920 };
  window.emit('move');
  assert.deepEqual(events.getState(), { gameMode: true, windowCovered: false, windowVisible: true });

  window.bounds = { ...window.bounds, x: 1000 };
  window.emit('move');
  assert.equal(window.webContents.sent.length, 2, 'touching the game edge leaves coverage unchanged');

  window.bounds = { ...window.bounds, x: 0, width: 100 };
  events.setGameMode(true, { ...gameBounds, x: 200 });
  assert.equal(events.getState().windowCovered, false, 'same display with a gap');
  window.bounds = { ...window.bounds, width: 250 };
  window.emit('resize');
  assert.equal(events.getState().windowCovered, true);
  events.setGameMode(true, { ...gameBounds, x: 300 });
  assert.equal(events.getState().windowCovered, false, 'the game can move while game mode stays active');
  events.setGameMode(true, gameBounds);
  events.setGameMode(false, gameBounds);
  assert.deepEqual(window.webContents.sent, [
    [STATE_CHANNEL, { gameMode: true, windowCovered: true, windowVisible: true }],
    [STATE_CHANNEL, { gameMode: true, windowCovered: false, windowVisible: true }],
    [STATE_CHANNEL, { gameMode: true, windowCovered: true, windowVisible: true }],
    [STATE_CHANNEL, { gameMode: true, windowCovered: false, windowVisible: true }],
    [STATE_CHANNEL, { gameMode: true, windowCovered: true, windowVisible: true }],
    [STATE_CHANNEL, { gameMode: false, windowCovered: false, windowVisible: true }]
  ]);
});

test('window coverage is recomputed independently of whether the window is visible', () => {
  const events = createSystemEventsController({ isTrustedUrl, log: quietLog });
  const window = fakeWindow();
  events.attachWindow(window);
  events.setGameMode(true, { height: 900, width: 1000, x: 0, y: 0 });

  window.visible = false;
  window.emit('hide');
  assert.deepEqual(events.getState(), { gameMode: true, windowCovered: true, windowVisible: false });

  window.visible = true;
  window.bounds = { ...window.bounds, x: 1920 };
  window.emit('show');
  assert.deepEqual(events.getState(), { gameMode: true, windowCovered: false, windowVisible: true });

  window.minimized = true;
  window.bounds = { ...window.bounds, x: 0 };
  window.emit('minimize');
  assert.deepEqual(events.getState(), { gameMode: true, windowCovered: true, windowVisible: false });

  window.minimized = false;
  window.bounds = { ...window.bounds, x: 1920 };
  window.emit('restore');
  assert.deepEqual(events.getState(), { gameMode: true, windowCovered: false, windowVisible: true });
});

test('system events are never sent to a page that is not the hosted app', () => {
  const events = createSystemEventsController({ isTrustedUrl, log: quietLog });
  const window = fakeWindow('file:///renderer-recovery.html');
  events.attachWindow(window);
  events.setGameMode(true);
  assert.deepEqual(window.webContents.sent, []);
  assert.deepEqual(events.getState(), { gameMode: true, windowCovered: false, windowVisible: true }, 'the state is still kept for getState');

  window.destroyed = true;
  assert.doesNotThrow(() => events.setGameMode(false));
});

test('waking from sleep or the lock screen is passed to the page, and dispose unhooks it', () => {
  const events = createSystemEventsController({ isTrustedUrl, log: quietLog });
  const window = fakeWindow();
  events.attachWindow(window);
  const powerMonitor = new EventEmitter();
  events.installPowerMonitor(powerMonitor);
  events.installPowerMonitor(powerMonitor);

  powerMonitor.emit('resume');
  powerMonitor.emit('unlock-screen');
  powerMonitor.emit('lock-screen');
  assert.deepEqual(window.webContents.sent, [
    [WAKE_CHANNEL, { reason: 'resume' }],
    [WAKE_CHANNEL, { reason: 'unlock-screen' }]
  ]);

  events.dispose();
  powerMonitor.emit('resume');
  assert.equal(window.webContents.sent.length, 2);
  assert.equal(powerMonitor.listenerCount('resume'), 0);
});

test('the state request is answered only for the trusted frame', () => {
  const events = createSystemEventsController({ isTrustedUrl, log: quietLog });
  const handlers = new Map();
  events.configureIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isTrustedFrame: (frame) => frame?.url === 'https://voiceroom.ru/'
  });
  const window = fakeWindow();
  events.attachWindow(window);
  events.setGameMode(true, window.bounds);
  const handler = handlers.get(GET_STATE_CHANNEL);
  assert.deepEqual(handler({ senderFrame: { url: 'https://voiceroom.ru/' } }), {
    gameMode: true,
    windowCovered: true,
    windowVisible: true
  });
  assert.throws(() => handler({ senderFrame: { url: 'https://evil.example/' } }));
});

test('hiding to the tray or minimizing tells the page the window cannot be seen', () => {
  const events = createSystemEventsController({ isTrustedUrl, log: quietLog });
  const window = fakeWindow();
  events.attachWindow(window);
  const states = () => window.webContents.sent.map(([, payload]) => payload.windowVisible);

  window.visible = false;
  window.emit('hide');
  window.emit('hide');
  window.visible = true;
  window.emit('show');
  window.minimized = true;
  window.emit('minimize');
  window.minimized = false;
  window.emit('restore');
  assert.deepEqual(states(), [false, true, false, true], 'one message per change');
  assert.deepEqual(events.getState(), { gameMode: false, windowCovered: false, windowVisible: true });

  window.emit('closed');
  window.visible = false;
  window.emit('hide');
  assert.equal(states().length, 4, 'a closed window is no longer followed');
});

test('a window created hidden (start in the tray) starts as not visible', () => {
  const events = createSystemEventsController({ isTrustedUrl, log: quietLog });
  const window = fakeWindow();
  window.visible = false;
  events.attachWindow(window);
  assert.deepEqual(events.getState(), { gameMode: false, windowCovered: false, windowVisible: false });
  window.visible = true;
  window.emit('show');
  assert.deepEqual(window.webContents.sent.at(-1), [STATE_CHANNEL, { gameMode: false, windowCovered: false, windowVisible: true }]);
});

test('the main window is throttled in the background only outside voice', () => {
  const throttling = createBackgroundThrottlingController({ log: quietLog });
  const window = fakeWindow();
  throttling.attachWindow(window);
  assert.deepEqual(window.webContents.throttling, [true], 'a new window outside a call may be throttled');
  assert.equal(throttling.isThrottlingAllowed(), true);

  throttling.setVoiceActive(true);
  throttling.setVoiceActive(true);
  throttling.setVoiceActive(false);
  assert.deepEqual(window.webContents.throttling, [true, false, true], 'applied once per change');

  throttling.setVoiceActive(true);
  const replacement = fakeWindow();
  throttling.attachWindow(replacement);
  assert.deepEqual(replacement.webContents.throttling, [false], 'a window created during a call keeps full speed');

  window.emit('closed');
  replacement.emit('closed');
  assert.doesNotThrow(() => throttling.setVoiceActive(false));
  assert.equal(replacement.webContents.throttling.length, 1);
});

test('a failing throttling call is logged and retried on the next change', () => {
  const warnings = [];
  const throttling = createBackgroundThrottlingController({ log: { info() {}, warn: (...args) => warnings.push(args) } });
  const window = fakeWindow();
  let fail = true;
  window.webContents.setBackgroundThrottling = (allowed) => {
    if (fail) throw new Error('gone');
    window.webContents.throttling.push(allowed);
  };
  throttling.attachWindow(window);
  assert.equal(warnings.length, 1);
  fail = false;
  throttling.setVoiceActive(false);
  assert.deepEqual(window.webContents.throttling, [true]);
});
