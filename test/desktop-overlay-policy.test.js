'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_INTERACTIVE_BINDING,
  DEFAULT_OVERLAY_SETTINGS,
  describeInteractiveHotkey,
  isOverlayHtmlUrl,
  resolveOverlayBounds,
  sanitizeOverlaySettings,
  sanitizeOverlaySnapshot,
  shouldShowOverlay
} = require('../electron/policies/overlay');

describe('overlay settings', () => {
  it('fills defaults and keeps a valid hotkey', () => {
    assert.deepEqual({ ...sanitizeOverlaySettings(undefined) }, { ...DEFAULT_OVERLAY_SETTINGS });
    assert.deepEqual({ ...sanitizeOverlaySettings({ enabled: false, opacity: 2, anchor: 'nope' }) }, {
      ...DEFAULT_OVERLAY_SETTINGS,
      anchor: 'top-left',
      enabled: false,
      opacity: 1
    });
    assert.deepEqual(sanitizeOverlaySettings({ interactiveBinding: { code: 'KeyO', ctrlKey: true } }).interactiveBinding, {
      altKey: false,
      code: 'KeyO',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false
    });
    assert.equal(sanitizeOverlaySettings({ interactiveBinding: null }).interactiveBinding, null);
    assert.deepEqual(
      sanitizeOverlaySettings({ interactiveBinding: { code: 'KeyA' } }).interactiveBinding,
      DEFAULT_INTERACTIVE_BINDING
    );
  });
});

describe('overlay snapshot', () => {
  it('keeps a bounded unique participant list', () => {
    assert.deepEqual(sanitizeOverlaySnapshot(null), { participants: [] });
    const snapshot = sanitizeOverlaySnapshot({
      participants: [
        { id: 'a', name: `  Ann${String.fromCharCode(7)}  `, speaking: true, micMuted: 1, self: true },
        { id: 'a', name: 'dup' },
        { id: 'bad id', name: 'x' },
        { id: 'b', name: 'Bob', outputMuted: true }
      ]
    });
    assert.deepEqual(snapshot.participants, [
      { id: 'a', micMuted: false, name: 'Ann', outputMuted: false, self: true, speaking: true },
      { id: 'b', micMuted: false, name: 'Bob', outputMuted: true, self: false, speaking: false }
    ]);
  });
});

describe('overlay visibility', () => {
  it('shows only over a detected game, or during an explicit preview', () => {
    assert.equal(shouldShowOverlay({ callActive: true, enabled: true, gameActive: false }), false);
    assert.equal(shouldShowOverlay({ callActive: true, enabled: true, gameActive: true }), true);
    assert.equal(shouldShowOverlay({ callActive: false, enabled: true, gameActive: true }), false);
    assert.equal(shouldShowOverlay({ callActive: true, enabled: false, gameActive: true }), false);
    assert.equal(shouldShowOverlay({
      callActive: true,
      enabled: true,
      gameActive: false,
      interactive: true
    }), true);
    assert.equal(shouldShowOverlay({
      callActive: false,
      enabled: true,
      gameActive: false,
      previewing: true
    }), true);
  });
});

describe('overlay bounds', () => {
  it('pins the HUD to the requested work-area corner', () => {
    const workArea = { height: 1000, width: 1600, x: 100, y: 40 };
    assert.deepEqual(resolveOverlayBounds({
      anchor: 'top-left',
      height: 120,
      width: 280,
      workArea
    }), { height: 120, width: 280, x: 116, y: 56 });
    assert.deepEqual(resolveOverlayBounds({
      anchor: 'bottom-right',
      height: 120,
      width: 280,
      workArea
    }), { height: 120, width: 280, x: 1404, y: 904 });
  });
});

describe('overlay helpers', () => {
  it('recognizes the overlay page and formats the hotkey', () => {
    assert.equal(isOverlayHtmlUrl('file:///C:/app/electron/ui/overlay.html'), true);
    assert.equal(isOverlayHtmlUrl('https://voiceroom.ru/'), false);
    assert.match(describeInteractiveHotkey(DEFAULT_INTERACTIVE_BINDING), /Ctrl\+`/);
  });
});
