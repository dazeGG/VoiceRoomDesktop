'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const {
  createScreenProfileId,
  getScreenQualityMaxHeight,
  getScreenQualityMaxWidth,
  normalizeApplyProfileRequest,
  normalizeDesktopCapturePickerSelection,
  normalizeScreenFpsId,
  normalizeScreenQualityId
} = require('../policies/desktop-capture');
const desktopCaptureState = require('./state');
const {
  cancelDesktopCapturePickerSession,
  clearPendingDesktopCaptureSource,
  getDesktopAudioCapabilities,
  getDesktopCapturePickerSessionForEvent,
  getDesktopCaptureSourceForSelection,
  getDesktopCaptureSources,
  isNativeOnlyScreenCaptureEligible,
  openDesktopCapturePickerWindow,
  peekPendingDesktopCaptureSource,
  resolveDesktopCapturePickerSession,
  serializeDesktopSource,
  setPendingDesktopCaptureSource,
  storeDesktopCaptureSourceSnapshot,
  takeGrantedDesktopCapture
} = desktopCaptureState;
const {
  ensureMacMicrophoneAccess,
  getFrameScopeKey,
  isTrustedFrame,
  isTrustedOrAppLoadingFrame,
  openMacMicrophoneSettings,
  openMacScreenCaptureSettings
} = require('../security');
const {
  reconfigureNativeCaptureSession,
  startNativeCaptureSession,
  stopNativeCaptureSession
} = require('../native/capture');
const { startSafeSystemAudioCapture, stopSafeSystemAudioCapture } = require('../native/audio');
const log = require('../logger');

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
      maxWidth: getScreenQualityMaxWidth(selection.qualityId),
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
      maxWidth: getScreenQualityMaxWidth(qualityId),
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
        maxWidth: pending.maxWidth,
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
        maxWidth: granted.maxWidth,
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

  ipcMain.handle('desktop-capture:apply-profile', async (event, options = {}) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop capture is only available for the configured Voice Room URL.');
    }

    const { fps, fpsId, maxHeight, maxWidth, qualityId } = normalizeApplyProfileRequest(options);
    const result = reconfigureNativeCaptureSession({ fps, maxHeight, maxWidth });

    if (!result.ok) {
      return {
        fpsId,
        maxHeight,
        maxWidth,
        ok: false,
        qualityId,
        reason: result.reason || 'reconfigure-failed'
      };
    }

    return {
      fpsId,
      maxHeight,
      maxWidth,
      ok: true,
      qualityId
    };
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

module.exports = {
  configureDesktopCaptureIpc,
  configureScreenPickerIpc,
  recordGrantedDesktopCapture: desktopCaptureState.recordGrantedDesktopCapture,
  takePendingDesktopCaptureSource: desktopCaptureState.takePendingDesktopCaptureSource
};
