'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, shell, Notification, powerMonitor } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getNativeCaptureCapabilities } = require('./native/capture');
const { runUpdateGate } = require('./policies/update-gate');
const { readBuildProfile } = require('./policies/update-gate-policy');
const {
  installBuildLabel,
  installMediaDeviceFilter,
  installNativeCaptureBridge,
  loadMainApplication,
  showRendererRecovery
} = require('./window/bootstrap');
const log = require('./logger');
const { WINDOW_BACKGROUND, buildDesktopLayoutCss } = require('./shell-theme');
const {
  configureDesktopCaptureIpc,
  configureScreenPickerIpc,
  recordGrantedDesktopCapture,
  takePendingDesktopCaptureSource
} = require('./desktop-capture');
const { getWindowsCaptureFeaturePolicy } = require('./policies/windows-capture');
const { createWindowLifecycleController } = require('./window/lifecycle');
const { resolveWindowsTrayIconPath } = require('./window/tray-icon');
const { disableWindowsApplicationMenu } = require('./window/menu-policy');
const { createDevDiagnosticsController } = require('./dev/diagnostics');
const { createAppBootstrap } = require('./app/bootstrap');
const { configureDesktopNotificationsIpc } = require('./notifications');
const { configureDesktopIdleIpc } = require('./idle');
const { createDesktopHotkeyController } = require('./hotkeys');
const { createNativeHotkeyBackend } = require('./native/hotkeys');
const {
  ensureMacMicrophoneAccess,
  grantMacMediaPermission,
  isPermissionContextTrusted,
  isTrustedDisplayMediaRequest,
  isTrustedFrame,
  isTrustedOrAppLoadingFrame,
  isTrustedUrl,
  getOriginFromUrl,
  readRuntimeConfig,
  setTrustedOrigin
} = require('./security');

const WINDOWS_HW_ENCODER_CHROMIUM_FEATURES = [
  'WebRTCHardwareVideoEncoderFrameDrop',
  'WebRtcAV1HWEncode'
];
const WINDOWS_HW_ENCODER_DISABLED_CHROMIUM_FEATURES = [
  'ForceSoftwareForRtcLowResolutions',
  'WebRtcScreenshareSwEncoding'
];

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

// Windows cursor-on-stream status quo: BOTH stock Chromium backends show a
// cursor while apps hide it. WGC lets Windows bake the real cursor into the
// frame ignoring app-level hiding; the legacy DXGI/GDI path goes through
// WebRTC's MouseCursorMonitorWin, which turns the hidden state (GetCursorInfo
// flags == 0) into a phantom default arrow. Don't toggle these flags hoping
// for correct behaviour — it only swaps one artefact for the other.
//
// The real fix is the native capture path (native-capture.js +
// ScreenCursorCapture.exe), which captures without the OS cursor and composites
// it honouring CURSOR_SHOWING. Keep Chromium WGC for Windows 11 and helper-missing
// fallback paths, but avoid forcing it on Windows 10 when the helper is present
// so the temporary Chromium grant does not keep a local yellow border visible.
if (process.platform === 'win32') {
  const nativeCaptureCapabilitiesAtLaunch = getNativeCaptureCapabilities();
  const windowsRelease = os.release();
  // Chromium feature switches are process-start-only, so the WGC screen-capturer
  // choice must be made from launch-time OS/helper state. The native helper is
  // still rechecked when a capture starts, and the renderer keeps its existing
  // fallback to the original Chromium stream if that later check fails.
  const captureFeaturePolicy = getWindowsCaptureFeaturePolicy({
    chromiumWgcOverride: process.env.VOICE_ROOM_CHROMIUM_WGC,
    nativeCaptureAvailable: nativeCaptureCapabilitiesAtLaunch.available,
    release: windowsRelease
  });
  log.info('Windows capture Chromium feature policy:', {
    disabledFeatures: captureFeaturePolicy.disabledFeatures,
    enabledFeatures: captureFeaturePolicy.enabledFeatures,
    nativeCaptureAvailable: nativeCaptureCapabilitiesAtLaunch.available,
    reason: captureFeaturePolicy.reason,
    release: windowsRelease
  });
  const enabledFeatures = [...captureFeaturePolicy.enabledFeatures];
  const disabledFeatures = [...captureFeaturePolicy.disabledFeatures];

  if (process.env.VOICE_ROOM_WEBRTC_HW_ENCODER !== '0') {
    enabledFeatures.push(...WINDOWS_HW_ENCODER_CHROMIUM_FEATURES);
    disabledFeatures.push(...WINDOWS_HW_ENCODER_DISABLED_CHROMIUM_FEATURES);
  }

  if (enabledFeatures.length > 0) {
    app.commandLine.appendSwitch('enable-features', enabledFeatures.join(','));
  }
  if (disabledFeatures.length > 0) {
    app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
  }
}

// Rooms auto-join without a page gesture. Electron defaults to the permissive
// autoplay policy, but pin it explicitly so a future Electron/Chromium default
// change never resurfaces the web client's "Разрешить звук" fallback button.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const runtimeConfig = readRuntimeConfig();
const APP_URL = process.env.VOICE_ROOM_URL || runtimeConfig.voiceRoomUrl || '';
const TRUSTED_ORIGIN = getOriginFromUrl(APP_URL);
setTrustedOrigin(TRUSTED_ORIGIN);
if (process.platform === 'win32') {
  app.setAppUserModelId('ru.dazinho.voiceroom');
}
const PICKER_PREVIEW_ENABLED = process.env.VOICE_ROOM_PICKER_PREVIEW === '1';
const ALLOWED_SESSION_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'media',
  'mediaKeySystem',
  'speaker-selection'
]);
const CHROMIUM_LOG_PATH = (process.env.VOICE_ROOM_CHROMIUM_LOG || path.join(os.tmpdir(), 'voice-room-chromium.log')).trim();
const WEBRTC_CAPTURE_VMODULE = [
  '*desktop_capture*=3',
  '*screen_capturer_win*=3',
  '*window_capturer_win*=3',
  '*desktop_and_cursor_composer*=3',
  '*wgc*=3'
].join(',');
const WEBRTC_INTERNALS_URL = 'chrome://webrtc-internals/';
const DESKTOP_LAYOUT_CSS = buildDesktopLayoutCss();

const devDiagnostics = createDevDiagnosticsController({
  app,
  browserWindow: BrowserWindow,
  chromiumLogPath: CHROMIUM_LOG_PATH,
  fs,
  log,
  readBuildProfile,
  shell,
  webrtcCaptureVmodule: WEBRTC_CAPTURE_VMODULE,
  windowBackground: WINDOW_BACKGROUND,
  webrtcInternalsUrl: WEBRTC_INTERNALS_URL
});

devDiagnostics.configureDevChromiumLogging();

disableWindowsApplicationMenu({ menu: Menu });

const windowLifecycle = createWindowLifecycleController({
  Menu,
  Tray,
  app,
  platform: process.platform,
  resolveTrayIconPath: resolveWindowsTrayIconPath
});

const desktopHotkeys = createDesktopHotkeyController({
  globalShortcut,
  isTrustedFrame,
  log,
  nativeHotkeys: createNativeHotkeyBackend({ app, log })
});

function configureWindowIpc() {
  ipcMain.handle('window:set-fullscreen', (event, fullscreen) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Window controls are only available for the configured Voice Room URL.');
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    window.setFullScreen(Boolean(fullscreen));
    return window.isFullScreen();
  });

  ipcMain.handle('window:is-fullscreen', (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Window controls are only available for the configured Voice Room URL.');
    }

    return Boolean(BrowserWindow.fromWebContents(event.sender)?.isFullScreen());
  });

  ipcMain.handle('window:reload-main', (event) => {
    const frameUrl = event.senderFrame?.url || '';
    if (!frameUrl.includes('renderer-recovery.html')) {
      throw new Error('Reload is only available from the recovery screen.');
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return { ok: false };

    return loadMainApplication(window, APP_URL, { dialog }).then(() => ({ ok: true }));
  });
}

const appBootstrap = createAppBootstrap({
  app,
  BrowserWindow,
  dialog,
  devDiagnostics,
  ensureMacMicrophoneAccess,
  grantMacMediaPermission,
  isPermissionContextTrusted,
  isTrustedDisplayMediaRequest,
  isTrustedUrl,
  installBuildLabel,
  installMediaDeviceFilter,
  installNativeCaptureBridge,
  log,
  loadMainApplication,
  readBuildProfile,
  showRendererRecovery,
  recordGrantedDesktopCapture,
  configureDesktopCaptureIpc,
  configureScreenPickerIpc,
  runUpdateGate,
  shell,
  takePendingDesktopCaptureSource,
  appUrl: APP_URL,
  allowedSessionPermissions: ALLOWED_SESSION_PERMISSIONS,
  desktopLayoutCss: DESKTOP_LAYOUT_CSS,
  previewEnabled: PICKER_PREVIEW_ENABLED,
  windowLifecycle
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    windowLifecycle.restoreMainWindow();
  });

  app.on('before-quit', () => {
    windowLifecycle.requestQuit();
  });

  app.on('will-quit', () => {
    desktopHotkeys.dispose();
  });

  async function launchApplication() {
    await appBootstrap.launchApplication();
  }

  app.whenReady().then(() => {
    // Process-wide IPC handlers and power-monitor listeners must be installed
    // once. On macOS, closing the last window keeps the app alive and a later
    // dock activation only needs to recreate the BrowserWindow.
    try {
      configureWindowIpc();
      configureDesktopIdleIpc({
        ipcMain,
        powerMonitor,
        isTrustedFrame
      });
      configureDesktopNotificationsIpc({
        ipcMain,
        Notification,
        isTrustedFrame,
        restoreMainWindow: () => windowLifecycle.restoreMainWindow()
      });
      desktopHotkeys.install(ipcMain);
      desktopHotkeys.installPowerMonitor(powerMonitor);
    } catch (error) {
      log.error('Application service setup failed:', error);
      app.quit();
      return;
    }

    launchApplication().catch((error) => {
      log.error('Application launch failed:', error);
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        launchApplication().catch((error) => {
          log.error('Application relaunch failed:', error);
          app.quit();
        });
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (windowLifecycle.shouldQuitForWindowAllClosed()) {
    app.quit();
  }
});
