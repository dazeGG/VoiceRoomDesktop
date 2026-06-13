'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getNativeAudioCapabilities,
  startSafeSystemAudioCapture,
  stopSafeSystemAudioCapture
} = require('./native-audio');
const {
  getNativeCaptureCapabilities,
  startNativeCaptureSession,
  stopNativeCaptureSession
} = require('./native-capture');
const { getNativeCaptureInjectScript } = require('./native-capture-policy');
const { runUpdateGate } = require('./update-gate');
const { readBuildProfile } = require('./update-gate-policy');
const log = require('./logger');
const { WINDOW_BACKGROUND } = require('./shell-theme');
const {
  createScreenProfileId,
  getScreenQualityMaxHeight,
  normalizeDesktopAudioCapture,
  normalizeDesktopCapturePickerSelection,
  normalizeScreenFpsId,
  normalizeScreenQualityId
} = require('./desktop-capture-policy');
const { getMediaDeviceFilterInjectScript } = require('./media-device-policy');
const { getWindowsCaptureFeaturePolicy } = require('./windows-capture-policy');

const WINDOWS_HW_ENCODER_CHROMIUM_FEATURES = [
  'WebRTCHardwareVideoEncoderFrameDrop',
  'WebRtcAV1HWEncode'
];
const WINDOWS_HW_ENCODER_DISABLED_CHROMIUM_FEATURES = [
  'ForceSoftwareForRtcLowResolutions',
  'WebRtcScreenshareSwEncoding'
];

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

const runtimeConfig = readRuntimeConfig();
const APP_URL = process.env.VOICE_ROOM_URL || runtimeConfig.voiceRoomUrl || '';
const TRUSTED_ORIGIN = APP_URL ? new URL(APP_URL).origin : '';
const PICKER_PREVIEW_ENABLED = process.env.VOICE_ROOM_PICKER_PREVIEW === '1';
const ALLOWED_SESSION_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'media',
  'mediaKeySystem',
  'speaker-selection'
]);
const DESKTOP_CAPTURE_PENDING_TTL_MS = 15_000;
const DESKTOP_CAPTURE_SOURCE_SNAPSHOT_TTL_MS = 30_000;
const GRANTED_DESKTOP_CAPTURE_TTL_MS = 10_000;
const grantedDesktopCaptureByFrame = new Map();
const CHROMIUM_LOG_PATH = (process.env.VOICE_ROOM_CHROMIUM_LOG || path.join(os.tmpdir(), 'voice-room-chromium.log')).trim();
const WEBRTC_CAPTURE_VMODULE = [
  '*desktop_capture*=3',
  '*screen_capturer_win*=3',
  '*window_capturer_win*=3',
  '*desktop_and_cursor_composer*=3',
  '*wgc*=3'
].join(',');
const pendingDesktopCaptureSources = new Map();
const desktopCaptureSourceSnapshots = new Map();
const desktopCapturePickerSessions = new Map();
const WEBRTC_INTERNALS_URL = 'chrome://webrtc-internals/';
let latestPendingDesktopCaptureSource = null;
let lastScreenCaptureSettingsOpenAt = 0;
let nextDesktopCapturePickerSessionId = 1;
let webRtcInternalsWindow = null;

const DESKTOP_DRAG_REGION_CSS = `
  body::before {
    -webkit-app-region: drag;
    content: "";
    position: fixed;
    top: 0;
    right: 0;
    left: 84px;
    height: 34px;
    z-index: 2147483647;
  }
`;

configureDevChromiumLogging();

function readRuntimeConfig() {
  const configPath = path.join(__dirname, 'runtime-config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function isTrustedUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin === TRUSTED_ORIGIN;
  } catch {
    return false;
  }
}

function isTrustedFrame(frame) {
  return Boolean(frame?.url && isTrustedUrl(frame.url));
}

function isTrustedDisplayMediaRequest(request) {
  return isTrustedFrame(request.frame) || isTrustedOrigin(request.securityOrigin);
}

function isTrustedOrigin(origin) {
  return Boolean(TRUSTED_ORIGIN) && origin === TRUSTED_ORIGIN;
}

function getOriginFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return '';
  }
}

function isTransitionalWebContentsUrl(rawUrl) {
  if (!rawUrl) return true;
  const normalized = rawUrl.trim().toLowerCase();
  return normalized === 'about:blank' || normalized.startsWith('about:');
}

function resolvePermissionContextOrigin(webContents, details = {}, requestingOrigin = '') {
  if (isTrustedOrigin(requestingOrigin)) return requestingOrigin;

  const securityOrigin = typeof details.securityOrigin === 'string' ? details.securityOrigin : '';
  if (isTrustedOrigin(securityOrigin)) return securityOrigin;

  const requestingUrlOrigin = getOriginFromUrl(details.requestingUrl);
  if (isTrustedOrigin(requestingUrlOrigin)) return requestingUrlOrigin;

  if (!webContents || webContents.isDestroyed?.()) {
    return '';
  }

  const currentOrigin = getOriginFromUrl(webContents.getURL());
  if (isTrustedOrigin(currentOrigin)) return currentOrigin;
  if (isTransitionalWebContentsUrl(webContents.getURL()) && TRUSTED_ORIGIN) {
    return TRUSTED_ORIGIN;
  }

  return '';
}

function isPermissionContextTrusted(webContents, details = {}, requestingOrigin = '') {
  return Boolean(resolvePermissionContextOrigin(webContents, details, requestingOrigin));
}

function isTrustedOrAppLoadingFrame(frame) {
  if (isTrustedFrame(frame)) return true;
  return isTransitionalWebContentsUrl(frame?.url) && Boolean(TRUSTED_ORIGIN);
}

function getMacMicrophoneAccessStatus() {
  if (process.platform !== 'darwin') return 'not-applicable';
  try {
    return systemPreferences.getMediaAccessStatus('microphone');
  } catch {
    return 'unknown';
  }
}

async function ensureMacMicrophoneAccess() {
  if (process.platform !== 'darwin') {
    return { granted: true, platform: process.platform, status: 'not-applicable' };
  }

  const status = getMacMicrophoneAccessStatus();
  if (status === 'granted') {
    return { granted: true, platform: process.platform, status };
  }
  if (status === 'denied' || status === 'restricted') {
    return { granted: false, platform: process.platform, status };
  }

  const granted = await systemPreferences.askForMediaAccess('microphone');
  return {
    granted,
    platform: process.platform,
    status: getMacMicrophoneAccessStatus()
  };
}

async function grantMacMediaPermission(details = {}) {
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  const wantsAudio = mediaTypes.length === 0 || mediaTypes.includes('audio');
  const wantsVideo = mediaTypes.includes('video');
  const prompts = [];

  if (wantsAudio) prompts.push(systemPreferences.askForMediaAccess('microphone'));
  if (wantsVideo) prompts.push(systemPreferences.askForMediaAccess('camera'));

  if (!prompts.length) return true;

  const results = await Promise.all(prompts);
  return results.every(Boolean);
}

function openMacMicrophoneSettings() {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone').catch((error) => {
    log.warn('Failed to open macOS Microphone settings:', error);
  });
}

function getFrameKey(frame) {
  if (!frame || typeof frame.processId !== 'number' || typeof frame.routingId !== 'number') return '';
  return `${frame.processId}:${frame.routingId}`;
}

function getFrameScopeKey(frame) {
  try {
    const topFrame = frame?.top;
    if (topFrame && !topFrame.isDestroyed?.()) return getFrameKey(topFrame);
  } catch {
    // Fall back to the requesting frame if Electron cannot resolve the top frame.
  }

  return getFrameKey(frame);
}

function serializeDesktopSource(source) {
  const thumbnail = source.thumbnail && !source.thumbnail.isEmpty()
    ? source.thumbnail.resize({ height: 180 }).toDataURL()
    : '';
  const appIcon = source.appIcon && !source.appIcon.isEmpty()
    ? source.appIcon.resize({ height: 32 }).toDataURL()
    : '';

  return {
    appIcon,
    id: source.id,
    name: source.name,
    thumbnail,
    type: source.id.startsWith('screen:') ? 'screen' : 'window'
  };
}

function configureDesktopCaptureIpc() {
  ipcMain.handle('desktop-capture:get-sources', async (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const frameKey = getFrameScopeKey(event.senderFrame);
    const sources = await getDesktopCaptureSources();
    if (frameKey) storeDesktopCaptureSourceSnapshot(frameKey, sources);

    return sources.map(serializeDesktopSource);
  });

  ipcMain.handle('desktop-capture:open-picker', async (event, options = {}) => {
    const frameKey = getFrameScopeKey(event.senderFrame);
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const sources = await getDesktopCaptureSources();
    if (!sources.length) {
      throw new Error('Нет доступных источников экрана');
    }

    const selection = await openDesktopCapturePickerWindow(parentWindow, sources, options);
    if (selection.cancelled) {
      return {
        cancelled: true,
        ok: false
      };
    }

    const source = sources.find((item) => item.id === selection.sourceId);
    if (!source) {
      throw new Error('Desktop capture source is no longer available.');
    }

    const audioOptions = {
      allowEchoFallback: false,
      enabled: selection.streamAudioEnabled,
      mode: 'safe-system'
    };
    const audioCapture = setPendingDesktopCaptureSource(frameKey, source, audioOptions, {
      fpsId: selection.fpsId,
      qualityId: selection.qualityId
    });

    return {
      audioCapture,
      fpsId: selection.fpsId,
      maxHeight: getScreenQualityMaxHeight(selection.qualityId),
      ok: true,
      profileId: createScreenProfileId(selection.qualityId, selection.fpsId),
      qualityId: selection.qualityId,
      source: serializeDesktopSource(source),
      streamAudioEnabled: selection.streamAudioEnabled
    };
  });

  ipcMain.handle('desktop-capture:select-source', async (event, sourceId, audioOptions = 'loopback', captureOptions = {}) => {
    const normalizedCaptureOptions = typeof captureOptions === 'object' && captureOptions !== null ? captureOptions : {};
    const frameKey = getFrameScopeKey(event.senderFrame);
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const source = await getDesktopCaptureSourceForSelection(frameKey, sourceId);
    if (!source) {
      throw new Error('Desktop capture source is no longer available.');
    }

    const qualityId = normalizeScreenQualityId(normalizedCaptureOptions.qualityId);
    const audioCapture = setPendingDesktopCaptureSource(frameKey, source, audioOptions, normalizedCaptureOptions);
    return {
      audioCapture,
      fpsId: normalizeScreenFpsId(normalizedCaptureOptions.fpsId),
      maxHeight: getScreenQualityMaxHeight(qualityId),
      ok: true,
      qualityId
    };
  });

  ipcMain.handle('desktop-audio:get-capabilities', (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    return getDesktopAudioCapabilities();
  });

  ipcMain.handle('native-capture:prepare', (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const pending = peekPendingDesktopCaptureSource(event.senderFrame);
    if (!pending?.source) return { ok: false, reason: 'no-pending-source' };
    if (!isNativeOnlyScreenCaptureEligible(pending)) {
      return {
        ok: false,
        reason: pending.source.id?.startsWith('screen:') ? 'chromium-audio-required' : 'source-not-screen'
      };
    }

    try {
      return startNativeCaptureSession(event.sender, {
        fps: pending.fps,
        maxHeight: pending.maxHeight,
        qualityId: pending.qualityId,
        sourceId: pending.source.id
      });
    } catch (error) {
      log.error('Native capture session failed to prepare:', error);
      return { ok: false, reason: 'start-failed' };
    }
  });

  ipcMain.handle('native-capture:commit-prepared', (event, sourceId = '') => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    clearPendingDesktopCaptureSource(String(sourceId || ''));
    return true;
  });

  ipcMain.handle('native-capture:start', (event) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const granted = takeGrantedDesktopCapture(event.senderFrame);
    if (!granted) return { ok: false, reason: 'no-granted-source' };

    try {
      return startNativeCaptureSession(event.sender, {
        fps: granted.fps,
        maxHeight: granted.maxHeight,
        qualityId: granted.qualityId,
        sourceId: granted.sourceId
      });
    } catch (error) {
      log.error('Native capture session failed to start:', error);
      return { ok: false, reason: 'start-failed' };
    }
  });

  ipcMain.handle('native-capture:stop', (event, sessionId = '') => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    return stopNativeCaptureSession(String(sessionId || ''));
  });

  ipcMain.handle('desktop-audio:start-safe-system', (event, options = {}) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    const session = startSafeSystemAudioCapture(event.sender, options);
    return { sessionId: session.sessionId };
  });

  ipcMain.handle('desktop-audio:ensure-media-access', async (event) => {
    if (!isTrustedOrAppLoadingFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    return ensureMacMicrophoneAccess();
  });

  ipcMain.handle('desktop-audio:open-settings', (event, options = {}) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    if (process.platform === 'darwin') {
      if (options.target === 'microphone') {
        openMacMicrophoneSettings();
        return { ok: true, target: 'mac-microphone' };
      }

      openMacScreenCaptureSettings({ force: true });
      return { ok: true, target: 'mac-screen-capture' };
    }

    return { ok: false, target: '' };
  });

  ipcMain.handle('desktop-audio:stop', (event, sessionId = '') => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop audio is only available for the configured Voice Room URL.');
    }

    return stopSafeSystemAudioCapture(sessionId);
  });
}

function configureScreenPickerIpc() {
  ipcMain.handle('screen-picker:get-state', (event) => {
    const session = getDesktopCapturePickerSessionForEvent(event);
    return {
      defaultFpsId: session.defaultFpsId,
      defaultQualityId: session.defaultQualityId,
      defaultStreamAudioEnabled: session.defaultStreamAudioEnabled,
      sources: session.sources.map(serializeDesktopSource)
    };
  });

  ipcMain.handle('screen-picker:select', (event, selection = {}) => {
    const session = getDesktopCapturePickerSessionForEvent(event);
    resolveDesktopCapturePickerSession(session, normalizeDesktopCapturePickerSelection(selection));
    return { ok: true };
  });

  ipcMain.handle('screen-picker:cancel', (event) => {
    const session = getDesktopCapturePickerSessionForEvent(event);
    cancelDesktopCapturePickerSession(session);
    return { ok: true };
  });
}

function getDesktopAudioCapabilities() {
  const nativeCapabilities = getNativeAudioCapabilities();
  return {
    label: 'Звук стрима',
    ...nativeCapabilities
  };
}

function setPendingDesktopCaptureSource(frameKey, source, audioOptions = 'loopback', captureOptions = {}) {
  const normalizedCaptureOptions = typeof captureOptions === 'object' && captureOptions !== null ? captureOptions : {};
  const previous = frameKey ? pendingDesktopCaptureSources.get(frameKey) : null;
  if (previous?.timer) clearTimeout(previous.timer);

  const timer = setTimeout(() => {
    if (frameKey) pendingDesktopCaptureSources.delete(frameKey);
    if (latestPendingDesktopCaptureSource?.source.id === source.id) {
      latestPendingDesktopCaptureSource = null;
    }
  }, DESKTOP_CAPTURE_PENDING_TTL_MS);
  timer.unref?.();

  const audioCapture = normalizeDesktopAudioCapture(source, audioOptions, getNativeAudioCapabilities());
  const fps = Number(normalizeScreenFpsId(normalizedCaptureOptions.fpsId));
  const qualityId = normalizeScreenQualityId(normalizedCaptureOptions.qualityId);
  const maxHeight = getScreenQualityMaxHeight(qualityId);
  const pendingSource = {
    audioCapture,
    fps,
    maxHeight,
    qualityId,
    source,
    timer
  };

  if (frameKey) pendingDesktopCaptureSources.set(frameKey, pendingSource);
  latestPendingDesktopCaptureSource = {
    audioCapture: pendingSource.audioCapture,
    expiresAt: Date.now() + DESKTOP_CAPTURE_PENDING_TTL_MS,
    fps,
    maxHeight,
    qualityId,
    source
  };

  return audioCapture;
}

// Remembers which source the display-media handler just granted so the
// injected getDisplayMedia wrapper can start the native cursor-correct
// capture for the same source right after the stream resolves.
function recordGrantedDesktopCapture(frame, pending) {
  if (process.platform !== 'win32') return;
  const frameKey = getFrameScopeKey(frame);
  if (!frameKey || !pending?.source) return;
  grantedDesktopCaptureByFrame.set(frameKey, {
    fps: pending.fps || 30,
    grantedAt: Date.now(),
    maxHeight: pending.maxHeight || getScreenQualityMaxHeight(pending.qualityId),
    qualityId: normalizeScreenQualityId(pending.qualityId),
    sourceId: pending.source.id
  });
}

function takeGrantedDesktopCapture(frame) {
  const frameKey = getFrameScopeKey(frame);
  const granted = frameKey ? grantedDesktopCaptureByFrame.get(frameKey) : null;
  if (frameKey) grantedDesktopCaptureByFrame.delete(frameKey);
  if (!granted || Date.now() - granted.grantedAt > GRANTED_DESKTOP_CAPTURE_TTL_MS) return null;
  return granted;
}

async function getDesktopCaptureSources() {
  assertMacScreenCaptureAccess();

  const sources = await desktopCapturer
    .getSources({
      fetchWindowIcons: true,
      thumbnailSize: { height: 360, width: 640 },
      types: ['screen', 'window']
    })
    .catch((error) => {
      if (process.platform === 'darwin') {
        openMacScreenCaptureSettings();
        throw createMacScreenCaptureAccessError(error);
      }

      throw error;
    });
  return sources.filter((source) => !isOwnDesktopCaptureSource(source));
}

function isOwnDesktopCaptureSource(source) {
  if (!source?.id?.startsWith('window:')) return false;
  return getOwnDesktopCaptureSourceIds().has(source.id);
}

function getOwnDesktopCaptureSourceIds() {
  const ids = new Set();
  for (const window of BrowserWindow.getAllWindows()) {
    const mediaSourceId = window.getMediaSourceId?.();
    if (mediaSourceId) ids.add(mediaSourceId);
  }
  return ids;
}

function storeDesktopCaptureSourceSnapshot(frameKey, sources) {
  clearDesktopCaptureSourceSnapshot(frameKey);

  const timer = setTimeout(() => {
    clearDesktopCaptureSourceSnapshot(frameKey);
  }, DESKTOP_CAPTURE_SOURCE_SNAPSHOT_TTL_MS);
  timer.unref?.();

  desktopCaptureSourceSnapshots.set(frameKey, {
    expiresAt: Date.now() + DESKTOP_CAPTURE_SOURCE_SNAPSHOT_TTL_MS,
    sources: new Map(sources.map((source) => [source.id, source])),
    timer
  });
}

function clearDesktopCaptureSourceSnapshot(frameKey) {
  const snapshot = desktopCaptureSourceSnapshots.get(frameKey);
  if (snapshot?.timer) clearTimeout(snapshot.timer);
  desktopCaptureSourceSnapshots.delete(frameKey);
}

async function getDesktopCaptureSourceForSelection(frameKey, sourceId) {
  const snapshotSource = getDesktopCaptureSourceFromSnapshot(frameKey, sourceId);
  if (snapshotSource) return snapshotSource;

  const sources = await getDesktopCaptureSources();
  return sources.find((source) => source.id === sourceId) || null;
}

function getDesktopCaptureSourceFromSnapshot(frameKey, sourceId) {
  const snapshot = frameKey ? desktopCaptureSourceSnapshots.get(frameKey) : null;
  if (!snapshot) return null;

  if (snapshot.expiresAt < Date.now()) {
    clearDesktopCaptureSourceSnapshot(frameKey);
    return null;
  }

  return snapshot.sources.get(sourceId) || null;
}

function assertMacScreenCaptureAccess() {
  if (process.platform !== 'darwin') return;

  const status = getMacScreenCaptureStatus();
  if (status === 'granted' || status === 'unknown') return;

  openMacScreenCaptureSettings();
  throw createMacScreenCaptureAccessError();
}

function getMacScreenCaptureStatus() {
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

function createMacScreenCaptureAccessError(cause) {
  const status = getMacScreenCaptureStatus();
  const appName = app.getName() || 'Voice Room';
  const devHint = process.defaultApp ? ' При запуске через npm run electron разрешение может называться Electron.' : '';
  const causeText = cause?.message ? `\nElectron: ${cause.message}` : '';
  const error = new Error(
    [
      'macOS не дала приложению доступ к записи экрана.',
      `Статус Screen Recording: ${status}.`,
      `Откройте System Settings -> Privacy & Security -> Screen & System Audio Recording и включите ${appName}.${devHint}`,
      'После изменения полностью закройте и снова откройте приложение.'
    ].join('\n') + causeText
  );
  error.name = 'ScreenCapturePermissionError';
  return error;
}

function openMacScreenCaptureSettings(options = {}) {
  const now = Date.now();
  if (!options.force && now - lastScreenCaptureSettingsOpenAt < 5000) return;

  lastScreenCaptureSettingsOpenAt = now;
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch((error) => {
    log.warn('Failed to open macOS Screen Recording settings:', error);
  });
}

function takeLatestPendingDesktopCaptureSource() {
  if (!latestPendingDesktopCaptureSource || latestPendingDesktopCaptureSource.expiresAt < Date.now()) {
    latestPendingDesktopCaptureSource = null;
    return null;
  }

  const { audioCapture, fps, maxHeight, qualityId, source } = latestPendingDesktopCaptureSource;
  clearPendingDesktopCaptureSource(source.id);
  return { audioCapture, fps, maxHeight, qualityId, source };
}

function takePendingDesktopCaptureSource(frame, securityOrigin = '') {
  const frameKey = getFrameScopeKey(frame);
  if (frameKey) {
    const pending = pendingDesktopCaptureSources.get(frameKey);
    pendingDesktopCaptureSources.delete(frameKey);
    if (pending?.timer) clearTimeout(pending.timer);
    if (pending?.source) {
      clearPendingDesktopCaptureSource(pending.source.id);
      return pending;
    }
  }

  if (!isTrustedFrame(frame) && !isTrustedOrigin(securityOrigin)) return null;
  return takeLatestPendingDesktopCaptureSource();
}

function clearPendingDesktopCaptureSource(sourceId) {
  if (latestPendingDesktopCaptureSource?.source.id === sourceId) {
    latestPendingDesktopCaptureSource = null;
  }

  for (const [frameKey, pending] of pendingDesktopCaptureSources.entries()) {
    if (pending.source.id !== sourceId) continue;
    if (pending.timer) clearTimeout(pending.timer);
    pendingDesktopCaptureSources.delete(frameKey);
  }
}

function peekPendingDesktopCaptureSource(frame, securityOrigin = '') {
  const frameKey = getFrameScopeKey(frame);
  const pending = frameKey ? pendingDesktopCaptureSources.get(frameKey) : null;
  if (pending?.source) return pending;
  if (!isTrustedFrame(frame) && !isTrustedOrigin(securityOrigin)) return null;
  if (!latestPendingDesktopCaptureSource || Date.now() > latestPendingDesktopCaptureSource.expiresAt) {
    latestPendingDesktopCaptureSource = null;
    return null;
  }
  return latestPendingDesktopCaptureSource;
}

function isNativeOnlyScreenCaptureEligible(pending) {
  return process.platform === 'win32'
    && pending?.source?.id?.startsWith('screen:')
    && pending.audioCapture?.mode !== 'loopback';
}

function openDesktopCapturePickerWindow(parentWindow, sources, options = {}) {
  const sessionId = String(nextDesktopCapturePickerSessionId++);
  const pickerWindow = new BrowserWindow({
    backgroundColor: WINDOW_BACKGROUND,
    height: 760,
    minHeight: 640,
    minWidth: 760,
    modal: Boolean(parentWindow),
    parent: parentWindow || undefined,
    show: false,
    title: 'Voice Room Stream Picker',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'screen-picker-preload.js'),
      sandbox: true
    },
    width: 1040
  });

  return new Promise((resolve, reject) => {
    const session = {
      defaultFpsId: normalizeScreenFpsId(options.fpsId),
      defaultQualityId: normalizeScreenQualityId(options.qualityId),
      defaultStreamAudioEnabled: options.streamAudioEnabled !== false,
      reject,
      resolve,
      sessionId,
      settled: false,
      sources,
      window: pickerWindow
    };
    desktopCapturePickerSessions.set(sessionId, session);

    pickerWindow.once('ready-to-show', () => {
      pickerWindow.show();
    });
    pickerWindow.once('closed', () => {
      if (!session.settled) {
        cancelDesktopCapturePickerSession(session);
      }
    });
    pickerWindow.loadFile(path.join(__dirname, 'screen-picker-preview.html'), {
      query: { sessionId }
    }).catch((error) => {
      rejectDesktopCapturePickerSession(session, error);
    });
  });
}

function getDesktopCapturePickerSessionForEvent(event) {
  const sessionId = getScreenPickerSessionId(event.senderFrame?.url || '');
  const session = sessionId ? desktopCapturePickerSessions.get(sessionId) : null;
  if (!session || session.window.webContents !== event.sender) {
    throw new Error('Screen picker session is not available.');
  }
  return session;
}

function getScreenPickerSessionId(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get('sessionId') || '';
  } catch {
    return '';
  }
}

function resolveDesktopCapturePickerSession(session, selection) {
  if (session.settled) return;
  session.settled = true;
  desktopCapturePickerSessions.delete(session.sessionId);

  if (!session.sources.some((source) => source.id === selection.sourceId)) {
    session.reject(new Error('Выбранный источник больше недоступен.'));
  } else {
    session.resolve(selection);
  }

  if (!session.window.isDestroyed()) session.window.close();
}

function cancelDesktopCapturePickerSession(session) {
  if (session.settled) return;
  session.settled = true;
  desktopCapturePickerSessions.delete(session.sessionId);
  session.resolve({
    cancelled: true,
    ok: false
  });
  if (!session.window.isDestroyed()) session.window.close();
}

function rejectDesktopCapturePickerSession(session, error) {
  if (session.settled) return;
  session.settled = true;
  desktopCapturePickerSessions.delete(session.sessionId);
  session.reject(error);
  if (!session.window.isDestroyed()) session.window.close();
}

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

    return loadMainApplication(window).then(() => ({ ok: true }));
  });
}

function isRecoveryUrl(rawUrl) {
  return String(rawUrl || '').includes('renderer-recovery.html');
}

function showRendererRecovery(window, details = {}) {
  if (!window || window.isDestroyed()) return;

  log.error('Renderer process gone:', details);
  window.loadFile(path.join(__dirname, 'renderer-recovery.html')).catch((error) => {
    log.error('Failed to open recovery screen:', error);
  });
}

function loadMainApplication(window) {
  if (!APP_URL) {
    dialog.showErrorBox('Voice Room', 'Не задан VOICE_ROOM_URL. Создайте .env или electron/runtime-config.json.');
    return Promise.resolve();
  }

  return window.loadURL(APP_URL).catch((error) => {
    dialog.showErrorBox('Voice Room', `Не удалось открыть ${APP_URL}\n\n${error.message}`);
  });
}

function installMediaDeviceFilter(webContents) {
  const script = getMediaDeviceFilterInjectScript();

  const inject = () => {
    if (webContents.isDestroyed()) return;
    webContents.executeJavaScript(script, true).catch((error) => {
      log.warn('Failed to install media device filter:', error);
    });
  };

  webContents.on('dom-ready', inject);
  webContents.on('did-navigate-in-page', inject);
}

function installNativeCaptureBridge(webContents) {
  if (process.platform !== 'win32') return;

  const capabilities = getNativeCaptureCapabilities();
  if (!capabilities.available) {
    log.info('Native cursor-correct capture is unavailable:', capabilities.reason);
    return;
  }

  const script = getNativeCaptureInjectScript();
  const inject = () => {
    if (webContents.isDestroyed()) return;
    webContents.executeJavaScript(script, true).catch((error) => {
      log.warn('Failed to install native capture bridge:', error);
    });
  };

  webContents.on('dom-ready', inject);
  webContents.on('did-navigate-in-page', inject);
}

function installBuildLabel(webContents) {
  const profile = readBuildProfile(app.getAppPath());
  const hash = profile?.buildHash || '';
  const text = hash ? `build: ${app.getVersion()} · ${hash}` : `build: ${app.getVersion()}`;
  const label = JSON.stringify(text);
  const script = `(function(){
    var id='voice-room-build-label';
    var existing=document.getElementById(id);
    if(existing){existing.textContent=${label};return;}
    var el=document.createElement('div');
    el.id=id;
    el.textContent=${label};
    el.style.cssText='position:fixed;left:8px;bottom:6px;z-index:2147483647;'+
      'font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;'+
      'color:currentColor;opacity:0.35;pointer-events:none;user-select:none;white-space:nowrap;';
    (document.body||document.documentElement).appendChild(el);
  })();`;

  const inject = () => {
    if (webContents.isDestroyed()) return;
    webContents.executeJavaScript(script, true).catch((error) => {
      log.warn('Failed to inject build label:', error);
    });
  };

  webContents.on('dom-ready', inject);
  webContents.on('did-navigate-in-page', inject);
}

function isDevDiagnosticsEnabled() {
  if (!app.isPackaged) return true;
  return readBuildProfile(app.getAppPath())?.channel === 'dev';
}

function configureDevChromiumLogging() {
  if (!isDevDiagnosticsEnabled()) return;

  try {
    fs.rmSync(CHROMIUM_LOG_PATH, { force: true });
  } catch (error) {
    log.warn('Failed to clear Chromium log:', error);
  }

  app.commandLine.appendSwitch('enable-logging', 'file');
  app.commandLine.appendSwitch('log-file', CHROMIUM_LOG_PATH);
  app.commandLine.appendSwitch('v', '1');
  app.commandLine.appendSwitch('vmodule', WEBRTC_CAPTURE_VMODULE);
}

function openWebRtcInternalsWindow(parentWindow) {
  if (!isDevDiagnosticsEnabled()) return;

  if (webRtcInternalsWindow && !webRtcInternalsWindow.isDestroyed()) {
    if (webRtcInternalsWindow.isMinimized()) webRtcInternalsWindow.restore();
    webRtcInternalsWindow.show();
    webRtcInternalsWindow.focus();
    return;
  }

  webRtcInternalsWindow = new BrowserWindow({
    backgroundColor: WINDOW_BACKGROUND,
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
  webRtcInternalsWindow.loadURL(WEBRTC_INTERNALS_URL).catch((error) => {
    log.warn('Failed to open WebRTC internals:', error);
  });
}

function openChromiumLogFile() {
  if (!isDevDiagnosticsEnabled()) return;

  if (!fs.existsSync(CHROMIUM_LOG_PATH)) {
    log.warn('Chromium log file is not available yet:', CHROMIUM_LOG_PATH);
    shell.openPath(path.dirname(CHROMIUM_LOG_PATH)).catch((error) => {
      log.warn('Failed to open Chromium log directory:', error);
    });
    return;
  }

  shell.openPath(CHROMIUM_LOG_PATH).catch((error) => {
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

function configurePermissions() {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    if (!ALLOWED_SESSION_PERMISSIONS.has(permission)) {
      log.warn('Denied permission request:', permission);
      callback(false);
      return;
    }

    if (!isPermissionContextTrusted(webContents, details)) {
      log.warn(
        'Denied permission request from untrusted page:',
        permission,
        webContents?.getURL?.(),
        details.requestingUrl
      );
      callback(false);
      return;
    }

    if (permission === 'media' && process.platform === 'darwin') {
      grantMacMediaPermission(details).then((granted) => {
        if (!granted) {
          log.warn('macOS media access denied:', details.mediaTypes || []);
        }
        callback(granted);
      }).catch((error) => {
        log.error('macOS media access prompt failed:', error);
        callback(false);
      });
      return;
    }

    callback(true);
  });

  defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
    if (!ALLOWED_SESSION_PERMISSIONS.has(permission)) {
      return false;
    }
    return isPermissionContextTrusted(webContents, details, requestingOrigin);
  });

  defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!isTrustedDisplayMediaRequest(request)) {
        callback({});
        return;
      }

      const pending = takePendingDesktopCaptureSource(request.frame, request.securityOrigin);
      if (!pending?.source) {
        callback({});
        return;
      }

      try {
        const canCaptureLoopbackAudio = request.audioRequested
          && pending.audioCapture?.mode === 'loopback';
        const response = { video: pending.source };
        if (canCaptureLoopbackAudio) response.audio = 'loopback';
        recordGrantedDesktopCapture(request.frame, pending);
        callback(response);
      } catch (error) {
        log.error('Display media request failed:', error);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

function createWindow() {
  if (PICKER_PREVIEW_ENABLED) {
    createPickerPreviewWindow();
    return;
  }

  if (!APP_URL) {
    dialog.showErrorBox('Voice Room', 'Не задан VOICE_ROOM_URL. Создайте .env или electron/runtime-config.json.');
    app.quit();
    return;
  }

  const mainWindow = new BrowserWindow({
    backgroundColor: WINDOW_BACKGROUND,
    height: 820,
    minHeight: 620,
    minWidth: 420,
    show: false,
    title: 'Voice Room',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      additionalArguments: [`--voice-room-desktop-version=${app.getVersion()}`],
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true
    },
    width: 1180
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  installMediaDeviceFilter(mainWindow.webContents);
  installNativeCaptureBridge(mainWindow.webContents);
  installBuildLabel(mainWindow.webContents);
  installDevDiagnosticsShortcut(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) return { action: 'allow' };
    shell.openExternal(url).catch((error) => {
      log.warn('Failed to open external URL:', url, error);
    });
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch((error) => {
      log.warn('Failed to open external URL:', url, error);
    });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    showRendererRecovery(mainWindow, details);
  });

  if (process.platform === 'darwin') {
    mainWindow.webContents.on('did-finish-load', () => {
      if (isRecoveryUrl(mainWindow.webContents.getURL())) return;
      mainWindow.webContents.insertCSS(DESKTOP_DRAG_REGION_CSS).catch((error) => {
        log.warn('Failed to inject desktop drag region CSS:', error);
      });
    });
  }

  loadMainApplication(mainWindow);
}

function createPickerPreviewWindow() {
  const previewWindow = new BrowserWindow({
    backgroundColor: WINDOW_BACKGROUND,
    height: 760,
    minHeight: 640,
    minWidth: 760,
    show: false,
    title: 'Voice Room Stream Picker Preview',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    width: 1040
  });

  previewWindow.once('ready-to-show', () => {
    previewWindow.show();
  });

  previewWindow.loadFile(path.join(__dirname, 'screen-picker-preview.html')).catch((error) => {
    dialog.showErrorBox('Voice Room', `Не удалось открыть preview\n\n${error.message}`);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  async function launchApplication() {
    configurePermissions();
    configureDesktopCaptureIpc();
    configureScreenPickerIpc();
    configureWindowIpc();

    const micAccess = await ensureMacMicrophoneAccess();
    if (!micAccess.granted && micAccess.status === 'denied') {
      log.warn('Microphone access denied in macOS privacy settings.');
    }

    const gate = await runUpdateGate({ previewEnabled: PICKER_PREVIEW_ENABLED });
    if (gate.ok) createWindow();
  }

  app.whenReady().then(() => {
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
  if (process.platform !== 'darwin') app.quit();
});
