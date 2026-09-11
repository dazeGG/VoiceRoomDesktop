'use strict';

const { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, shell, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureDesktopAttentionIpc } = require('./attention');
const { createAutostartController } = require('./autostart');
const { createCallControlsController } = require('./call-controls');
const { createDeepLinkController, resolveProtocolScheme } = require('./deep-links');
const { createDiagnosticsController } = require('./diagnostics');
const { getNativeAudioCapabilities } = require('./native/audio');
const { findNativeHotkeyHelper } = require('./native/hotkeys');
const { createCallSurfaces, createWindowsTaskbarThemeReader } = require('./window/call-surfaces');
const { consumeRelaunchIntent, resolveStartHidden, writeRelaunchIntent } = require('./app/launch-mode');
const { createKeepAwakeController } = require('./keep-awake');
const { getNativeCaptureCapabilities } = require('./native/capture');
const { createBackgroundUpdateController } = require('./policies/update-background');
const { runUpdateGate } = require('./policies/update-gate');
const { readBuildProfile, shouldRunUpdateGateState } = require('./policies/update-gate-policy');
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
const { createWindowStateController } = require('./window/state');
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

const windowState = createWindowStateController({
  app,
  fs,
  log,
  path,
  // The screen module is only usable after app ready; resolve it lazily.
  screen: {
    getAllDisplays: () => require('electron').screen.getAllDisplays(),
    getDisplayMatching: (bounds) => require('electron').screen.getDisplayMatching(bounds),
    getPrimaryDisplay: () => require('electron').screen.getPrimaryDisplay()
  }
});

const desktopHotkeys = createDesktopHotkeyController({
  globalShortcut,
  isTrustedFrame,
  log,
  nativeHotkeys: createNativeHotkeyBackend({ app, log })
});

const keepAwake = createKeepAwakeController({ powerSaveBlocker, log });
desktopHotkeys.onVoiceActiveChange((active) => keepAwake.setVoiceActive(active));

const autostart = createAutostartController({ app, fs, log, path });
let backgroundUpdates = null;
let launchInProgress = null;
// Replaced by the guarded launcher once the single-instance lock is held.
let requestLaunch = () => Promise.resolve();

const callControls = createCallControlsController({ log });
const callSurfaces = createCallSurfaces({
  app,
  Menu,
  dispatch: (action) => callControls.dispatch(action),
  log,
  nativeImage,
  nativeTheme,
  platform: process.platform,
  ...(process.platform === 'win32'
    ? { taskbarTheme: createWindowsTaskbarThemeReader({ execFileSync: require('node:child_process').execFileSync, log }) }
    : {}),
  windowLifecycle
});
callControls.onStateChange((state) => callSurfaces.apply(state));

const diagnostics = createDiagnosticsController({
  app,
  clipboard,
  getAutostartSettings: () => autostart.getSettings(),
  getHotkeysBackend: () => desktopHotkeys.getBackend(),
  getNativeHelpers: () => ({
    audio: getNativeAudioCapabilities().nativeSafeLoopback,
    capture: getNativeCaptureCapabilities().available,
    hotkeys: Boolean(findNativeHotkeyHelper({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath }).path)
  }),
  getUpdateState: () => backgroundUpdates?.getState?.() ?? null,
  isVoiceActive: () => desktopHotkeys.isVoiceActive() || callControls.getState().active,
  log,
  readBuildProfile,
  shell
});
windowLifecycle.setDiagnosticsActions({
  copyInfo: () => diagnostics.copyInfo(),
  openLogsFolder: () => {
    void diagnostics.openLogsFolder();
  }
});

const deepLinks = createDeepLinkController({
  app,
  appUrl: APP_URL,
  dialog,
  getMainWindow: () => windowLifecycle.getMainWindow(),
  isTrustedFrame,
  isVoiceActive: () => desktopHotkeys.isVoiceActive() || callControls.getState().active,
  log,
  // macOS keeps running without windows; a link then opens a fresh one.
  onWindowMissing: () => {
    if (!app.isReady() || launchInProgress) return;
    requestLaunch().catch((error) => {
      log.error('Application relaunch for a link failed:', error);
    });
  },
  restoreMainWindow: () => windowLifecycle.restoreMainWindow(),
  scheme: resolveProtocolScheme({ isPackaged: app.isPackaged, buildProfile: readBuildProfile(app.getAppPath()) })
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
  onMainWindowCreated: (window) => {
    deepLinks.attachWindow(window);
    callSurfaces.attachWindow(window);
  },
  resolveLaunchUrl: () => deepLinks.takeInitialUrl(),
  windowLifecycle,
  windowState
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // macOS delivers links through open-url, possibly before the app is ready.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deepLinks.handleUrl(url);
  });

  app.on('second-instance', (_event, argv) => {
    windowLifecycle.restoreMainWindow();
    deepLinks.handleArgv(argv);
  });

  app.on('before-quit', () => {
    windowLifecycle.requestQuit();
  });

  app.on('will-quit', () => {
    desktopHotkeys.dispose();
    keepAwake.dispose();
    backgroundUpdates?.dispose();
  });

  function resolveInitialStartHidden() {
    if (PICKER_PREVIEW_ENABLED) return false;

    const relaunchIntent = consumeRelaunchIntent({ fs, path, userDataPath: app.getPath('userData') });
    // A link click is an explicit request to see the app, even at login.
    if (deepLinks.hasInitialLink()) return false;
    let loginItemSettings = null;
    if (process.platform === 'darwin' && app.isPackaged) {
      try {
        loginItemSettings = app.getLoginItemSettings();
      } catch (error) {
        log.warn('Failed to read macOS login item state:', error);
      }
    }

    return resolveStartHidden({
      argv: process.argv,
      loginItemSettings,
      platform: process.platform,
      relaunchIntent,
      startMinimized: autostart.readStoredSettings().startMinimized
    });
  }

  function startBackgroundUpdates(gate) {
    if (backgroundUpdates) return;
    const enabled = shouldRunUpdateGateState({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      previewEnabled: PICKER_PREVIEW_ENABLED
    });
    if (!enabled) return;

    backgroundUpdates = createBackgroundUpdateController({
      autoUpdater: require('electron-updater').autoUpdater,
      beforeInstall: ({ startHidden }) => {
        writeRelaunchIntent({ fs, path, startHidden, userDataPath: app.getPath('userData') });
      },
      isMainWindowVisible: () => windowLifecycle.isMainWindowVisible(),
      isVoiceActive: () => desktopHotkeys.isVoiceActive(),
      log,
      onStateChange: ({ phase, version }) => {
        windowLifecycle.setUpdateAction(phase === 'ready'
          ? {
              click: () => backgroundUpdates?.installNow({ startHidden: false }),
              label: version ? `Установить обновление ${version}` : 'Установить обновление'
            }
          : null);
      }
    });
    backgroundUpdates.installPowerMonitor(powerMonitor);
    backgroundUpdates.start({
      lastCheckFailed: gate.updateError === true,
      updatePending: gate.updateAvailable === true
    });
  }

  // One launch at a time: the Dock, second instances and links share the guard.
  function launchApplication(options) {
    if (launchInProgress) return launchInProgress;
    launchInProgress = (async () => {
      const gate = await appBootstrap.launchApplication(options);
      if (gate?.ok) startBackgroundUpdates(gate);
    })().finally(() => {
      launchInProgress = null;
    });
    return launchInProgress;
  }
  requestLaunch = launchApplication;

  deepLinks.captureInitialArgv(process.argv);

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
      configureDesktopAttentionIpc({
        app,
        BrowserWindow,
        ipcMain,
        isTrustedFrame,
        nativeImage
      });
      desktopHotkeys.install(ipcMain);
      desktopHotkeys.installPowerMonitor(powerMonitor);
      keepAwake.installPowerMonitor(powerMonitor);
      autostart.configureIpc({ ipcMain, isTrustedFrame });
      callControls.configureIpc({ ipcMain, isTrustedFrame });
      diagnostics.configureIpc({ ipcMain, isTrustedFrame });
      deepLinks.configureIpc({ ipcMain });
      if (!PICKER_PREVIEW_ENABLED) deepLinks.registerProtocol();
    } catch (error) {
      log.error('Application service setup failed:', error);
      app.quit();
      return;
    }

    launchApplication({ startHidden: resolveInitialStartHidden() }).catch((error) => {
      log.error('Application launch failed:', error);
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        launchApplication().catch((error) => {
          log.error('Application relaunch failed:', error);
          app.quit();
        });
        return;
      }
      // macOS: a login-item launch keeps the window hidden until the Dock icon
      // is clicked.
      windowLifecycle.restoreMainWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (windowLifecycle.shouldQuitForWindowAllClosed()) {
    app.quit();
  }
});
