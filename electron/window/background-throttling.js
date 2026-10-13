'use strict';

// The main window runs its timers and animations at full speed only while voice
// is active: a call must keep its audio meters, realtime heartbeat and overlay
// snapshot going while the window sits in the tray or behind a game. Outside a
// call a hidden window is throttled like a background browser tab (Chromium
// then also reports the page as hidden, which the web app already handles).
//
// On Electron 44 both directions take effect at once, even for a window that is
// already hidden (Electron 41 applied `true` only on the next hide), so a call
// that starts in the tray is never held back and a call that ends there stops
// costing right away. The intensive wake-up throttling that would cut a hidden
// page to one timer a minute after five minutes is disabled in main.js, so the
// realtime heartbeat keeps working.
function createBackgroundThrottlingController({ log = console } = {}) {
  let window = null;
  let voiceActive = false;
  let applied = null;

  function apply() {
    if (!window || window.isDestroyed?.()) return;
    const allowed = !voiceActive;
    if (applied === allowed) return;
    try {
      window.webContents.setBackgroundThrottling(allowed);
      applied = allowed;
      log.info?.(`Main window background throttling ${allowed ? 'allowed' : 'off for voice'}`);
    } catch (error) {
      log.warn?.('Failed to change main window background throttling:', error);
    }
  }

  function attachWindow(next) {
    window = next || null;
    applied = null;
    if (!window) return;
    window.once?.('closed', () => {
      if (window !== next) return;
      window = null;
      applied = null;
    });
    apply();
  }

  function setVoiceActive(active) {
    voiceActive = Boolean(active);
    apply();
  }

  return {
    attachWindow,
    isThrottlingAllowed: () => applied === true,
    setVoiceActive
  };
}

module.exports = { createBackgroundThrottlingController };
