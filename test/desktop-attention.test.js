'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
  BADGE_CHANNEL,
  MAX_BADGE_COUNT,
  OVERLAY_ICON_PIXELS,
  REQUEST_CHANNEL,
  configureDesktopAttentionIpc,
  createBadgeOverlayBitmap,
  normalizeBadgeCount
} = require('../electron/attention');

class FakeWindow extends EventEmitter {
  constructor({ focused = false, visible = true } = {}) {
    super();
    this.destroyed = false;
    this.focused = focused;
    this.visible = visible;
    this.flashCalls = [];
    this.overlayCalls = [];
  }

  flashFrame(flag) { this.flashCalls.push(flag); }
  isDestroyed() { return this.destroyed; }
  isFocused() { return this.focused; }
  isVisible() { return this.visible; }
  setOverlayIcon(image, description) { this.overlayCalls.push([image, description]); }
}

function createHarness({
  dock,
  platform = 'win32',
  setBadgeCountResult = true,
  trusted = true,
  window = new FakeWindow()
} = {}) {
  const handlers = new Map();
  const badgeCounts = [];
  const bounces = [];
  const createdImages = [];

  configureDesktopAttentionIpc({
    app: {
      dock: dock === undefined ? { bounce: (type) => bounces.push(type) } : dock,
      setBadgeCount(count) {
        badgeCounts.push(count);
        return setBadgeCountResult;
      }
    },
    BrowserWindow: { fromWebContents: (sender) => sender.window },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    },
    isTrustedFrame: () => trusted,
    nativeImage: {
      createFromBitmap(buffer, options) {
        const image = { buffer, options };
        createdImages.push(image);
        return image;
      }
    },
    platform
  });

  const event = { sender: { window }, senderFrame: { url: 'https://voice.example/room' } };
  return {
    badgeCounts,
    bounces,
    createdImages,
    window,
    requestAttention: (options) => handlers.get(REQUEST_CHANNEL)(event, options),
    setBadgeCount: (value) => handlers.get(BADGE_CHANNEL)(event, value)
  };
}

describe('desktop attention badge', () => {
  it('normalizes badge counts to bounded non-negative integers', () => {
    assert.equal(normalizeBadgeCount(3), 3);
    assert.equal(normalizeBadgeCount(2.9), 2);
    assert.equal(normalizeBadgeCount(0.5), 0);
    assert.equal(normalizeBadgeCount(-4), 0);
    assert.equal(normalizeBadgeCount(Number.NaN), 0);
    assert.equal(normalizeBadgeCount(Number.POSITIVE_INFINITY), 0);
    assert.equal(normalizeBadgeCount('5'), 0);
    assert.equal(normalizeBadgeCount(undefined), 0);
    assert.equal(normalizeBadgeCount(1e9), MAX_BADGE_COUNT);
  });

  it('rejects untrusted renderer frames before touching the badge or window', () => {
    for (const platform of ['win32', 'darwin']) {
      const harness = createHarness({ platform, trusted: false });

      assert.throws(() => harness.setBadgeCount(3), /Desktop attention is only available for the configured Voice Room URL\./);
      assert.throws(() => harness.requestAttention(), /Desktop attention is only available for the configured Voice Room URL\./);
      assert.deepEqual(harness.badgeCounts, []);
      assert.deepEqual(harness.bounces, []);
      assert.deepEqual(harness.window.overlayCalls, []);
      assert.deepEqual(harness.window.flashCalls, []);
    }
  });

  it('sets and clears the macOS Dock badge count', () => {
    const harness = createHarness({ platform: 'darwin' });

    assert.deepEqual(harness.setBadgeCount(4), { ok: true, count: 4 });
    assert.deepEqual(harness.setBadgeCount(0), { ok: true, count: 0 });
    assert.deepEqual(harness.badgeCounts, [4, 0]);
    assert.deepEqual(harness.window.overlayCalls, []);
  });

  it('reports unsupported platforms where Electron cannot set a badge', () => {
    const harness = createHarness({ platform: 'linux', setBadgeCountResult: false });

    assert.deepEqual(harness.setBadgeCount(2), { ok: false, reason: 'unsupported' });
  });

  it('shows and clears a Windows taskbar overlay, creating the icon once', () => {
    const harness = createHarness();

    assert.deepEqual(harness.setBadgeCount(3), { ok: true, count: 3 });
    assert.deepEqual(harness.setBadgeCount(12), { ok: true, count: 12 });
    assert.deepEqual(harness.setBadgeCount(0), { ok: true, count: 0 });

    assert.equal(harness.createdImages.length, 1);
    assert.deepEqual(harness.createdImages[0].options, {
      width: OVERLAY_ICON_PIXELS,
      height: OVERLAY_ICON_PIXELS,
      scaleFactor: 2
    });
    assert.deepEqual(harness.window.overlayCalls, [
      [harness.createdImages[0], 'Непрочитанных: 3'],
      [harness.createdImages[0], 'Непрочитанных: 12'],
      [null, '']
    ]);
    assert.deepEqual(harness.badgeCounts, []);
  });

  it('restores the Windows overlay when the window returns from the tray', () => {
    const harness = createHarness();

    harness.setBadgeCount(5);
    harness.setBadgeCount(6);
    assert.equal(harness.window.listenerCount('show'), 1);

    harness.window.emit('show');
    assert.deepEqual(harness.window.overlayCalls.at(-1), [harness.createdImages[0], 'Непрочитанных: 6']);

    harness.setBadgeCount(0);
    const callsAfterClear = harness.window.overlayCalls.length;
    harness.window.emit('show');
    assert.equal(harness.window.overlayCalls.length, callsAfterClear);
  });

  it('fails closed when the sender has no window', () => {
    const harness = createHarness({ window: null });

    assert.deepEqual(harness.setBadgeCount(1), { ok: false, reason: 'no-window' });
    assert.deepEqual(harness.requestAttention(), { ok: false, reason: 'no-window' });
  });
});

describe('desktop attention overlay bitmap', () => {
  it('draws a premultiplied anti-aliased red dot on a transparent square', () => {
    const size = OVERLAY_ICON_PIXELS;
    const bitmap = createBadgeOverlayBitmap();
    const pixel = (x, y) => [...bitmap.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

    assert.equal(bitmap.length, size * size * 4);
    assert.deepEqual(pixel(0, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixel(size / 2, size / 2), [0x43, 0x3f, 0xf2, 255]);

    let partial = 0;
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      const alpha = bitmap[offset + 3];
      assert.ok(bitmap[offset] <= alpha && bitmap[offset + 1] <= alpha && bitmap[offset + 2] <= alpha);
      if (alpha > 0 && alpha < 255) partial++;
    }
    assert.ok(partial > 0, 'edge pixels should be anti-aliased');
  });
});

describe('desktop attention request', () => {
  it('does nothing while the window is focused', () => {
    for (const platform of ['win32', 'darwin']) {
      const harness = createHarness({ platform, window: new FakeWindow({ focused: true }) });

      assert.deepEqual(harness.requestAttention({ critical: true }), { ok: true, requested: false });
      assert.deepEqual(harness.window.flashCalls, []);
      assert.deepEqual(harness.bounces, []);
    }
  });

  it('flashes the Windows taskbar until focus with a single focus listener', () => {
    const harness = createHarness();

    assert.deepEqual(harness.requestAttention(), { ok: true, requested: true });
    assert.deepEqual(harness.requestAttention(), { ok: true, requested: true });
    assert.deepEqual(harness.window.flashCalls, [true, true]);
    assert.equal(harness.window.listenerCount('focus'), 1);

    harness.window.emit('focus');
    assert.deepEqual(harness.window.flashCalls, [true, true, false]);
    assert.equal(harness.window.listenerCount('focus'), 0);

    harness.requestAttention();
    assert.equal(harness.window.listenerCount('focus'), 1);
  });

  it('reports a Windows window hidden to the tray instead of flashing it', () => {
    const harness = createHarness({ window: new FakeWindow({ visible: false }) });

    assert.deepEqual(harness.requestAttention(), { ok: false, reason: 'window-hidden' });
    assert.deepEqual(harness.window.flashCalls, []);
  });

  it('bounces the macOS Dock icon, critical only when explicitly requested', () => {
    const harness = createHarness({ platform: 'darwin' });

    assert.deepEqual(harness.requestAttention(), { ok: true, requested: true });
    harness.requestAttention({ critical: true });
    harness.requestAttention({ critical: 'yes' });

    assert.deepEqual(harness.bounces, ['informational', 'critical', 'informational']);
    assert.deepEqual(harness.window.flashCalls, []);
  });

  it('reports unsupported when the macOS Dock API is unavailable', () => {
    const harness = createHarness({ dock: null, platform: 'darwin' });

    assert.deepEqual(harness.requestAttention(), { ok: false, reason: 'unsupported' });
  });
});
