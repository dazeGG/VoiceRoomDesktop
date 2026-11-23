'use strict';

const { boundsOverlap } = require('./policies/overlay');

// During a call the page reads as visible even in the tray. The shell reports
// game mode, window visibility and coverage by a game, plus system wake events.
const GET_STATE_CHANNEL = 'desktop-system:get-state';
const STATE_CHANNEL = 'desktop-system:state';
const WAKE_CHANNEL = 'desktop-system:wake';
const WAKE_EVENTS = Object.freeze(['resume', 'unlock-screen']);
const WINDOW_STATE_EVENTS = Object.freeze(['move', 'resize', 'show', 'hide', 'minimize', 'restore']);
const DEFAULT_STATE = Object.freeze({ gameMode: false, windowCovered: false, windowVisible: true });

function isWindowVisible(window) {
  if (!window || window.isDestroyed?.()) return false;
  return window.isVisible?.() === true && window.isMinimized?.() !== true;
}

function createSystemEventsController({ isTrustedUrl = () => true, log = console } = {}) {
  let window = null;
  let windowListeners = [];
  let gameBounds = null;
  let state = DEFAULT_STATE;
  let powerMonitor = null;
  let powerMonitorListeners = [];

  function getState() {
    return { ...state };
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

  function syncWindowState(gameMode = state.gameMode, notify = true) {
    const windowVisible = window ? isWindowVisible(window) : state.windowVisible;
    // Game bounds and BrowserWindow bounds are both in DIP.
    const windowCovered = gameMode && gameBounds && window && !window.isDestroyed?.()
      ? boundsOverlap(gameBounds, window.getBounds?.(), 0)
      : false;
    if (gameMode === state.gameMode && windowCovered === state.windowCovered && windowVisible === state.windowVisible) return;
    state = { gameMode, windowCovered, windowVisible };
    if (notify) send(STATE_CHANNEL, getState());
  }

  function attachWindow(next) {
    detachWindow();
    window = next || null;
    if (window) {
      const sync = () => syncWindowState();
      windowListeners = WINDOW_STATE_EVENTS.map((eventName) => [eventName, sync]);
      windowListeners.push(['closed', () => attachWindow(null)]);
      for (const [eventName, listener] of windowListeners) window.on?.(eventName, listener);
    }
    syncWindowState(state.gameMode, false);
  }

  function setGameMode(active, bounds = null) {
    const gameMode = active === true;
    if (gameMode !== state.gameMode) log.info?.(`Game mode ${gameMode ? 'on' : 'off'}`);
    gameBounds = gameMode ? bounds : null;
    syncWindowState(gameMode);
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
        throw new Error('Desktop system state is only available for the configured VoiceRoom URL.');
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
    gameBounds = null;
    state = DEFAULT_STATE;
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
