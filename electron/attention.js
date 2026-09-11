'use strict';

const BADGE_CHANNEL = 'desktop-attention:set-badge-count';
const REQUEST_CHANNEL = 'desktop-attention:request';
const MAX_BADGE_COUNT = 9999;
const MAX_BADGE_LABEL_COUNT = 99;
const OVERLAY_ICON_PIXELS = 32;
const OVERLAY_ICON_SCALE_FACTOR = 2;
const OVERLAY_DOT_RGB = [0xf2, 0x3f, 0x43];
const OVERLAY_TEXT_RGB = [0xff, 0xff, 0xff];
const OVERLAY_SUPERSAMPLING = 4;

// Stroke outlines of the badge characters in a unit box (x right, y down),
// drawn with round caps so they stay legible at 16 DIP.
const GLYPHS = {
  0: [[[0.5, 0], [0.88, 0.12], [1, 0.5], [0.88, 0.88], [0.5, 1], [0.12, 0.88], [0, 0.5], [0.12, 0.12], [0.5, 0]]],
  1: [[[0.2, 0.22], [0.62, 0], [0.62, 1]]],
  2: [[[0.03, 0.22], [0.3, 0.01], [0.7, 0.01], [0.96, 0.24], [0.9, 0.46], [0.02, 1], [1, 1]]],
  3: [[[0.04, 0.1], [0.35, 0], [0.75, 0.02], [0.95, 0.22], [0.85, 0.42], [0.5, 0.48], [0.88, 0.56], [1, 0.78], [0.8, 0.97], [0.4, 1], [0.03, 0.9]]],
  4: [[[0.78, 1], [0.78, 0], [0, 0.68], [1, 0.68]]],
  5: [[[0.95, 0], [0.15, 0], [0.08, 0.44], [0.45, 0.38], [0.85, 0.48], [1, 0.72], [0.85, 0.94], [0.45, 1], [0.03, 0.9]]],
  6: [[[0.9, 0.06], [0.55, 0], [0.18, 0.14], [0.01, 0.52], [0.06, 0.84], [0.4, 1], [0.78, 0.98], [1, 0.76], [0.92, 0.52], [0.58, 0.4], [0.25, 0.46], [0.03, 0.62]]],
  7: [[[0, 0], [1, 0], [0.38, 1]]],
  8: [[[0.5, 0.47], [0.14, 0.3], [0.12, 0.1], [0.5, 0], [0.88, 0.1], [0.86, 0.3], [0.5, 0.47], [0.06, 0.66], [0.1, 0.92], [0.5, 1], [0.9, 0.92], [0.94, 0.66], [0.5, 0.47]]],
  '+': [[[0.5, 0.18], [0.5, 0.82]], [[0.14, 0.5], [0.86, 0.5]]]
};
GLYPHS[9] = GLYPHS[6].map((stroke) => stroke.map(([x, y]) => [1 - x, 1 - y]));

// Glyph height as a share of the icon: fewer characters get bigger ones.
const LABEL_HEIGHT_BY_LENGTH = [0, 0.5, 0.44, 0.34];

function normalizeBadgeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 0;
  return Math.min(Math.floor(value), MAX_BADGE_COUNT);
}

function formatBadgeLabel(count) {
  return count > MAX_BADGE_LABEL_COUNT ? `${MAX_BADGE_LABEL_COUNT}+` : String(count);
}

function describeBadgeCount(count) {
  return count > 0 ? `Непрочитанных: ${count}` : '';
}

function layoutLabel(label, size) {
  const height = size * LABEL_HEIGHT_BY_LENGTH[label.length];
  const width = height * 0.62;
  const gap = height * 0.2;
  const total = label.length * width + (label.length - 1) * gap;
  const top = (size - height) / 2;
  const segments = [];
  let left = (size - total) / 2;

  for (const char of label) {
    for (const stroke of GLYPHS[char]) {
      for (let index = 1; index < stroke.length; index++) {
        const [x1, y1] = stroke[index - 1];
        const [x2, y2] = stroke[index];
        segments.push([left + x1 * width, top + y1 * height, left + x2 * width, top + y2 * height]);
      }
    }
    left += width + gap;
  }

  return { segments, halfStroke: Math.max(1, height * 0.085) };
}

function distanceToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Premultiplied BGRA bitmap of an anti-aliased dot for the Windows taskbar
// overlay, with the unread count written on it when a label is given.
function createBadgeOverlayBitmap(size = OVERLAY_ICON_PIXELS, label = '') {
  const bitmap = Buffer.alloc(size * size * 4);
  const radius = size / 2;
  const samples = OVERLAY_SUPERSAMPLING * OVERLAY_SUPERSAMPLING;
  const text = label ? layoutLabel(label, size) : null;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      let inked = 0;
      for (let sy = 0; sy < OVERLAY_SUPERSAMPLING; sy++) {
        for (let sx = 0; sx < OVERLAY_SUPERSAMPLING; sx++) {
          const px = x + (sx + 0.5) / OVERLAY_SUPERSAMPLING;
          const py = y + (sy + 0.5) / OVERLAY_SUPERSAMPLING;
          const dx = px - radius;
          const dy = py - radius;
          if (dx * dx + dy * dy > radius * radius) continue;
          covered++;
          if (text && text.segments.some((segment) => distanceToSegment(px, py, segment) <= text.halfStroke)) inked++;
        }
      }

      const alpha = covered / samples;
      const ink = covered ? inked / covered : 0;
      const channel = (index) => Math.round((OVERLAY_DOT_RGB[index] * (1 - ink) + OVERLAY_TEXT_RGB[index] * ink) * alpha);
      const offset = (y * size + x) * 4;
      bitmap[offset] = channel(2);
      bitmap[offset + 1] = channel(1);
      bitmap[offset + 2] = channel(0);
      bitmap[offset + 3] = Math.round(255 * alpha);
    }
  }

  return bitmap;
}

function getSenderWindow(BrowserWindow, event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window && !window.isDestroyed() ? window : null;
}

function configureDesktopAttentionIpc({
  app,
  BrowserWindow,
  ipcMain,
  isTrustedFrame,
  nativeImage,
  platform = process.platform
}) {
  const windowsBadgeCounts = new WeakMap();
  const windowsAwaitingFocus = new WeakSet();
  const overlayIcons = new Map();

  function assertTrustedSender(event) {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop attention is only available for the configured Voice Room URL.');
    }
  }

  function getOverlayIcon(count) {
    const label = formatBadgeLabel(count);
    if (!overlayIcons.has(label)) {
      overlayIcons.set(label, nativeImage.createFromBitmap(createBadgeOverlayBitmap(OVERLAY_ICON_PIXELS, label), {
        width: OVERLAY_ICON_PIXELS,
        height: OVERLAY_ICON_PIXELS,
        scaleFactor: OVERLAY_ICON_SCALE_FACTOR
      }));
    }
    return overlayIcons.get(label);
  }

  function applyWindowsOverlay(window, count) {
    window.setOverlayIcon(count > 0 ? getOverlayIcon(count) : null, describeBadgeCount(count));
  }

  function setWindowsBadge(window, count) {
    if (!windowsBadgeCounts.has(window)) {
      // Hiding to the tray removes the taskbar button; re-apply the overlay when it returns.
      window.on('show', () => {
        const current = windowsBadgeCounts.get(window) || 0;
        if (current > 0 && !window.isDestroyed()) applyWindowsOverlay(window, current);
      });
    }
    windowsBadgeCounts.set(window, count);
    applyWindowsOverlay(window, count);
  }

  function flashWindowsTaskbar(window) {
    window.flashFrame(true);
    if (windowsAwaitingFocus.has(window)) return;

    windowsAwaitingFocus.add(window);
    window.once('focus', () => {
      windowsAwaitingFocus.delete(window);
      if (!window.isDestroyed()) window.flashFrame(false);
    });
  }

  ipcMain.handle(BADGE_CHANNEL, (event, value) => {
    assertTrustedSender(event);
    const count = normalizeBadgeCount(value);

    if (platform === 'win32') {
      const window = getSenderWindow(BrowserWindow, event);
      if (!window) return { ok: false, reason: 'no-window' };
      setWindowsBadge(window, count);
      return { ok: true, count };
    }

    return app.setBadgeCount(count) ? { ok: true, count } : { ok: false, reason: 'unsupported' };
  });

  ipcMain.handle(REQUEST_CHANNEL, (event, options) => {
    assertTrustedSender(event);
    const window = getSenderWindow(BrowserWindow, event);
    if (!window) return { ok: false, reason: 'no-window' };
    if (window.isFocused()) return { ok: true, requested: false };

    if (platform === 'darwin') {
      if (!app.dock) return { ok: false, reason: 'unsupported' };
      app.dock.bounce(options?.critical === true ? 'critical' : 'informational');
      return { ok: true, requested: true };
    }

    // A window hidden to the tray has no taskbar button to flash.
    if (!window.isVisible()) return { ok: false, reason: 'window-hidden' };
    flashWindowsTaskbar(window);
    return { ok: true, requested: true };
  });
}

module.exports = {
  BADGE_CHANNEL,
  MAX_BADGE_COUNT,
  OVERLAY_ICON_PIXELS,
  REQUEST_CHANNEL,
  configureDesktopAttentionIpc,
  createBadgeOverlayBitmap,
  formatBadgeLabel,
  normalizeBadgeCount
};
