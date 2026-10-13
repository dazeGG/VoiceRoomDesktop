'use strict';

// What the shell knows about the computer around the page, for the web app:
// game mode (a game is on screen and the app window is not in front), whether
// the window can be seen at all (not hidden to the tray, not minimized), and
// wake signals (back from sleep or from the lock screen). During a call the
// page reads as visible even in the tray, so it would never learn either from
// the Page Visibility API.
const GET_STATE_CHANNEL = 'desktop-system:get-state';
const STATE_CHANNEL = 'desktop-system:state';
const WAKE_CHANNEL = 'desktop-system:wake';
const WAKE_EVENTS = Object.freeze(['resume', 'unlock-screen']);
const WINDOW_VISIBILITY_EVENTS = Object.freeze(['show', 'hide', 'minimize', 'restore']);

function isWindowVisible(window) {
  if (!window || window.isDestroyed?.()) return false;
  return window.isVisible?.() === true && window.isMinimized?.() !== true;
}

function createSystemEventsController({ isTrustedUrl = () => true, log = console } = {}) {
  let window = null;
  let windowListeners = [];
  let gameMode = false;
  let windowVisible = true;
  let powerMonitor = null;
  let powerMonitorListeners = [];

  function getState() {
    return { gameMode, windowVisible };
  }

  function send(channel, payload) {
    const webContents = window && !window.isDestroyed?.() ? window.webContents : null;
    if (!webContents || webContents.isDestroyed?.()) return false;
    // Only the hosted app gets these, never the recovery or a foreign page.
    if (!isTrustedUrl(webContents.getURL?.() || '')) return false;
    try {
      webContents.send(channel, payload);
      return true;
    } catch (error) {
      log.warn?.('Failed to send a system event to the page:', error);
      return false;
    }
  }

  function detachWindow() {
    if (window) {
      for (const [eventName, listener] of windowListeners) window.removeListener?.(eventName, listener);
    }
    window = null;
    windowListeners = [];
  }

  function syncWindowVisible() {
    const next = isWindowVisible(window);
    if (next === windowVisible) return;
    windowVisible = next;
    send(STATE_CHANNEL, getState());
  }

  function attachWindow(next) {
    detachWindow();
    window = next || null;
    if (!window) return;
    windowListeners = WINDOW_VISIBILITY_EVENTS.map((eventName) => [eventName, syncWindowVisible]);
    for (const [eventName, listener] of windowListeners) window.on?.(eventName, listener);
    window.once?.('closed', () => {
      if (window === next) detachWindow();
    });
    windowVisible = isWindowVisible(window);
  }

  function setGameMode(active) {
    const next = active === true;
    if (next === gameMode) return;
    gameMode = next;
    log.info?.(`Game mode ${gameMode ? 'on' : 'off'}`);
    send(STATE_CHANNEL, getState());
  }

  function installPowerMonitor(nextPowerMonitor) {
    if (powerMonitor || !nextPowerMonitor?.on) return;
    powerMonitor = nextPowerMonitor;
    powerMonitorListeners = WAKE_EVENTS.map((reason) => [reason, () => {
      log.info?.('System wake:', reason);
      send(WAKE_CHANNEL, { reason });
    }]);
    for (const [eventName, listener] of powerMonitorListeners) powerMonitor.on(eventName, listener);
  }

  function configureIpc({ ipcMain, isTrustedFrame }) {
    ipcMain.handle(GET_STATE_CHANNEL, (event) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('Desktop system state is only available for the configured Voice Room URL.');
      }
      return getState();
    });
  }

  function dispose() {
    if (powerMonitor) {
      for (const [eventName, listener] of powerMonitorListeners) powerMonitor.removeListener?.(eventName, listener);
    }
    powerMonitor = null;
    powerMonitorListeners = [];
    detachWindow();
    gameMode = false;
    windowVisible = true;
  }

  return {
    attachWindow,
    configureIpc,
    dispose,
    getState,
    installPowerMonitor,
    setGameMode
  };
}

module.exports = {
  GET_STATE_CHANNEL,
  STATE_CHANNEL,
  WAKE_CHANNEL,
  WAKE_EVENTS,
  createSystemEventsController
};
