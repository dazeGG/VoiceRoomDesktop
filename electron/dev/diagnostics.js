'use strict';

const { BrowserWindow, shell } = require('electron');
const path = require('node:path');

function createDevDiagnosticsController({
  app,
  fs,
  log,
  readBuildProfile,
  chromiumLogPath,
  webrtcCaptureVmodule,
  webrtcInternalsUrl = 'chrome://webrtc-internals/',
  windowBackground,
  browserWindow = BrowserWindow,
  shellModule = shell
}) {
  let webRtcInternalsWindow = null;

  function isDevDiagnosticsEnabled() {
    if (!app.isPackaged) return true;
    return readBuildProfile(app.getAppPath())?.channel === 'dev';
  }

  function configureDevChromiumLogging() {
    if (!isDevDiagnosticsEnabled()) return;

    try {
      fs.rmSync(chromiumLogPath, { force: true });
    } catch (error) {
      log.warn('Failed to clear Chromium log:', error);
    }

    app.commandLine.appendSwitch('enable-logging', 'file');
    app.commandLine.appendSwitch('log-file', chromiumLogPath);
    app.commandLine.appendSwitch('v', '1');
    app.commandLine.appendSwitch('vmodule', webrtcCaptureVmodule);
  }

  function openWebRtcInternalsWindow(parentWindow) {
    if (!isDevDiagnosticsEnabled()) return;

    if (webRtcInternalsWindow && !webRtcInternalsWindow.isDestroyed()) {
      if (webRtcInternalsWindow.isMinimized()) webRtcInternalsWindow.restore();
      webRtcInternalsWindow.show();
      webRtcInternalsWindow.focus();
      return;
    }

    webRtcInternalsWindow = new browserWindow({
      backgroundColor: windowBackground,
      height: 820,
      parent: parentWindow || undefined,
      show: false,
      title: 'Voice Room WebRTC Internals',
      width: 1180,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    webRtcInternalsWindow.once('ready-to-show', () => {
      if (!webRtcInternalsWindow?.isDestroyed()) webRtcInternalsWindow.show();
    });
    webRtcInternalsWindow.once('closed', () => {
      webRtcInternalsWindow = null;
    });
    webRtcInternalsWindow.loadURL(webrtcInternalsUrl).catch((error) => {
      log.warn('Failed to open WebRTC internals:', error);
    });
  }

  function openChromiumLogFile() {
    if (!isDevDiagnosticsEnabled()) return;

    if (!fs.existsSync(chromiumLogPath)) {
      log.warn('Chromium log file is not available yet:', chromiumLogPath);
      shellModule.openPath(path.dirname(chromiumLogPath)).catch((error) => {
        log.warn('Failed to open Chromium log directory:', error);
      });
      return;
    }

    shellModule.openPath(chromiumLogPath).catch((error) => {
      log.warn('Failed to open Chromium log:', error);
    });
  }

  function installDevDiagnosticsShortcut(window) {
    if (!isDevDiagnosticsEnabled()) return;

    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (!input.shift || (!input.control && !input.meta)) return;

      const key = String(input.key || '').toLowerCase();
      const code = String(input.code || '');
      const opensInternals = key === 'w' || code === 'KeyW';
      const opensLog = key === 'l' || code === 'KeyL';
      if (!opensInternals && !opensLog) return;

      event.preventDefault();
      if (opensInternals) {
        openWebRtcInternalsWindow(window);
      } else {
        openChromiumLogFile();
      }
    });
  }

  return {
    configureDevChromiumLogging,
    installDevDiagnosticsShortcut,
    isDevDiagnosticsEnabled,
    openChromiumLogFile,
    openWebRtcInternalsWindow
  };
}

module.exports = { createDevDiagnosticsController };
