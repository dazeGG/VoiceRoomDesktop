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
    assert.deepEqual({ ...sanitizeOverlaySettings({ enabled: false, opacity: 2, anchor: 'nope', version: 2 }) }, {
      ...DEFAULT_OVERLAY_SETTINGS,
      anchor: 'top-left',
      enabled: false,
      opacity: 1
    });
    assert.equal(sanitizeOverlaySettings({ opacity: 0, version: 2 }).opacity, 0.2);
    // Files written before version 2 stored the whole-HUD opacity, often 1.
    assert.equal(DEFAULT_OVERLAY_SETTINGS.opacity, 0.5);
    assert.equal(sanitizeOverlaySettings({ opacity: 1 }).opacity, 0.5);
    assert.equal(sanitizeOverlaySettings({ opacity: 1 }).version, 2);
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
  it('keeps https avatars and drops anything else', () => {
    const [participant] = sanitizeOverlaySnapshot({
      participants: [{
        avatarAccent: 'oklch(58% 0.26 278)',
        avatarColorKey: 'blurple',
        avatarUrl: 'https://voiceroom.ru/avatars/a.png',
        id: 'a',
        name: 'Ann'
      }, {
        avatarUrl: 'javascript:alert(1)',
        id: 'b',
        name: 'Bad'
      }]
    }).participants;
    assert.equal(participant.avatarUrl, 'https://voiceroom.ru/avatars/a.png');
    assert.equal(participant.avatarColorKey, 'blurple');
    assert.equal(sanitizeOverlaySnapshot({
      participants: [{ avatarUrl: 'http://evil.example/a.png', id: 'b', name: 'Bad' }]
    }).participants[0].avatarUrl, '');
  });

  it('resolves same-origin avatar paths against the Voice Room URL', () => {
    const baseUrl = 'https://voiceroom.ru';
    const avatarOf = (avatarUrl, options) => sanitizeOverlaySnapshot({
      participants: [{ avatarUrl, id: 'a', name: 'Ann' }]
    }, options).participants[0].avatarUrl;
    assert.equal(avatarOf('/api/avatars/key%201', { baseUrl }), 'https://voiceroom.ru/api/avatars/key%201');
    assert.equal(avatarOf('/api/avatars/key-1'), '');
    assert.equal(avatarOf('//evil.example/a.png', { baseUrl }), '');
    assert.equal(avatarOf('/api/avatars/key-1', { baseUrl: 'http://voiceroom.ru' }), '');
  });

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
      {
        avatarAccent: '',
        avatarColorKey: '',
        avatarUrl: '',
        id: 'a',
        micMuted: false,
        name: 'Ann',
        outputMuted: false,
        self: true,
        speaking: true
      },
      {
        avatarAccent: '',
        avatarColorKey: '',
        avatarUrl: '',
        id: 'b',
        micMuted: false,
        name: 'Bob',
        outputMuted: true,
        self: false,
        speaking: false
      }
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
