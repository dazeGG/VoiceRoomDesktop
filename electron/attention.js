'use strict';

const BADGE_CHANNEL = 'desktop-attention:set-badge-count';
const REQUEST_CHANNEL = 'desktop-attention:request';
const MAX_BADGE_COUNT = 9999;
const OVERLAY_ICON_PIXELS = 32;
const OVERLAY_ICON_SCALE_FACTOR = 2;
const OVERLAY_DOT_RGB = [0xf2, 0x3f, 0x43];
const OVERLAY_SUPERSAMPLING = 4;

function normalizeBadgeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 0;
  return Math.min(Math.floor(value), MAX_BADGE_COUNT);
}

function describeBadgeCount(count) {
  return count > 0 ? `Непрочитанных: ${count}` : '';
}

// Premultiplied BGRA bitmap of an anti-aliased dot for the Windows taskbar overlay.
function createBadgeOverlayBitmap(size = OVERLAY_ICON_PIXELS) {
  const bitmap = Buffer.alloc(size * size * 4);
  const radius = size / 2;
  const samples = OVERLAY_SUPERSAMPLING * OVERLAY_SUPERSAMPLING;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < OVERLAY_SUPERSAMPLING; sy++) {
        for (let sx = 0; sx < OVERLAY_SUPERSAMPLING; sx++) {
          const dx = x + (sx + 0.5) / OVERLAY_SUPERSAMPLING - radius;
          const dy = y + (sy + 0.5) / OVERLAY_SUPERSAMPLING - radius;
          if (dx * dx + dy * dy <= radius * radius) covered++;
        }
      }

      const alpha = covered / samples;
      const offset = (y * size + x) * 4;
      bitmap[offset] = Math.round(OVERLAY_DOT_RGB[2] * alpha);
      bitmap[offset + 1] = Math.round(OVERLAY_DOT_RGB[1] * alpha);
      bitmap[offset + 2] = Math.round(OVERLAY_DOT_RGB[0] * alpha);
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
  let overlayIcon = null;

  function assertTrustedSender(event) {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop attention is only available for the configured Voice Room URL.');
    }
  }

  function getOverlayIcon() {
    if (!overlayIcon) {
      overlayIcon = nativeImage.createFromBitmap(createBadgeOverlayBitmap(), {
        width: OVERLAY_ICON_PIXELS,
        height: OVERLAY_ICON_PIXELS,
        scaleFactor: OVERLAY_ICON_SCALE_FACTOR
      });
    }
    return overlayIcon;
  }

  function applyWindowsOverlay(window, count) {
    window.setOverlayIcon(count > 0 ? getOverlayIcon() : null, describeBadgeCount(count));
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
  normalizeBadgeCount
};
