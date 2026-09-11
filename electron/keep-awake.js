'use strict';

// Keeps the display awake while the renderer reports an active voice connection
// (talking, streaming, or watching a stream). The blocker is released while the
// screen is locked: a locked machine means the user stepped away.
function createKeepAwakeController({ powerSaveBlocker, log = console }) {
  let voiceActive = false;
  let screenLocked = false;
  let blockerId = null;
  let powerMonitor = null;
  let powerMonitorListeners = [];

  function sync() {
    const shouldBlock = voiceActive && !screenLocked;

    if (shouldBlock && blockerId === null) {
      try {
        blockerId = powerSaveBlocker.start('prevent-display-sleep');
      } catch (error) {
        log.warn?.('Failed to keep the display awake:', error);
      }
      return;
    }

    if (!shouldBlock && blockerId !== null) {
      try {
        if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      } catch (error) {
        log.warn?.('Failed to release the display sleep blocker:', error);
      }
      blockerId = null;
    }
  }

  function setVoiceActive(active) {
    voiceActive = Boolean(active);
    sync();
  }

  function setScreenLocked(locked) {
    screenLocked = Boolean(locked);
    sync();
  }

  function installPowerMonitor(nextPowerMonitor) {
    if (powerMonitor || !nextPowerMonitor?.on) return;
    powerMonitor = nextPowerMonitor;
    powerMonitorListeners = [
      ['lock-screen', () => setScreenLocked(true)],
      ['unlock-screen', () => setScreenLocked(false)]
    ];
    for (const [eventName, listener] of powerMonitorListeners) {
      powerMonitor.on(eventName, listener);
    }
  }

  function dispose() {
    voiceActive = false;
    sync();
    if (powerMonitor) {
      for (const [eventName, listener] of powerMonitorListeners) {
        powerMonitor.removeListener?.(eventName, listener);
      }
    }
    powerMonitor = null;
    powerMonitorListeners = [];
    screenLocked = false;
  }

  return {
    dispose,
    installPowerMonitor,
    isBlocking: () => blockerId !== null,
    setScreenLocked,
    setVoiceActive
  };
}

module.exports = { createKeepAwakeController };
