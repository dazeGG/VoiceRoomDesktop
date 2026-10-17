'use strict';

// Tells the hosted page about the shell's own update, so the page shows one
// "update available" notice for both the web app and the shell, and lets the
// page start the restart into a downloaded release. The background updater
// (policies/update-background.js) does the checking and downloading; this only
// mirrors its phase and forwards the install request.
const GET_STATE_CHANNEL = 'desktop-update:get-state';
const INSTALL_CHANNEL = 'desktop-update:install';
const STATE_CHANNEL = 'desktop-update:state';

// The page knows three states: nothing to do, a release downloading, one ready.
function toPageState(updaterState) {
  const phase = updaterState?.phase;
  const status = phase === 'ready' ? 'ready' : phase === 'downloading' ? 'downloading' : 'none';
  const version = status !== 'none' && typeof updaterState?.version === 'string' ? updaterState.version : '';
  return { status, version };
}

function createUpdateBridge({ isTrustedUrl = () => true, log = console } = {}) {
  let window = null;
  let updater = null;
  let lastSent = '';

  function getState() {
    return toPageState(updater?.getState?.());
  }

  function send() {
    const webContents = window && !window.isDestroyed?.() ? window.webContents : null;
    if (!webContents || webContents.isDestroyed?.()) return false;
    // Only the hosted app gets these, never the recovery or a foreign page.
    if (!isTrustedUrl(webContents.getURL?.() || '')) return false;
    const state = getState();
    const key = JSON.stringify(state);
    if (key === lastSent) return false;
    try {
      webContents.send(STATE_CHANNEL, state);
      lastSent = key;
      return true;
    } catch (error) {
      log.warn?.('Failed to send the update state to the page:', error);
      return false;
    }
  }

  function attachWindow(next) {
    window = next || null;
    lastSent = '';
  }

  /** The background updater, once it runs; packaged builds only. */
  function attachUpdater(next) {
    updater = next || null;
    send();
  }

  /** Call when the updater's phase changes. */
  function publish() {
    send();
  }

  function configureIpc({ ipcMain, isTrustedFrame }) {
    ipcMain.handle(GET_STATE_CHANNEL, (event) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('Desktop update state is only available for the configured VoiceRoom URL.');
      }
      return getState();
    });
    ipcMain.handle(INSTALL_CHANNEL, (event) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('Desktop updates can only be installed from the configured VoiceRoom URL.');
      }
      // The page asks only outside a call; the updater still refuses unless a release is ready.
      const started = updater?.installNow?.({ startHidden: false }) === true;
      if (!started) throw new Error('No downloaded update to install.');
      return true;
    });
  }

  function dispose() {
    window = null;
    updater = null;
    lastSent = '';
  }

  return { attachUpdater, attachWindow, configureIpc, dispose, getState, publish };
}

module.exports = {
  GET_STATE_CHANNEL,
  INSTALL_CHANNEL,
  STATE_CHANNEL,
  createUpdateBridge,
  toPageState
};
