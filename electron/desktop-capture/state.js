'use strict';

const { BrowserWindow, desktopCapturer } = require('electron');
const path = require('node:path');
const { getNativeAudioCapabilities } = require('../native/audio');
const {
  getScreenQualityMaxHeight,
  getScreenQualityMaxWidth,
  normalizeDesktopAudioCapture,
  normalizeScreenFpsId,
  normalizeScreenQualityId
} = require('../policies/desktop-capture');
const {
  createMacScreenCaptureAccessError,
  getFrameScopeKey,
  isTrustedFrame,
  isTrustedOrigin,
  openMacScreenCaptureSettings
} = require('../security');
const { WINDOW_BACKGROUND } = require('../shell-theme');

const DESKTOP_CAPTURE_PENDING_TTL_MS = 15_000;
const DESKTOP_CAPTURE_SOURCE_SNAPSHOT_TTL_MS = 30_000;
const GRANTED_DESKTOP_CAPTURE_TTL_MS = 10_000;

const pendingDesktopCaptureSources = new Map();
const desktopCaptureSourceSnapshots = new Map();
const desktopCapturePickerSessions = new Map();
const grantedDesktopCaptureByFrame = new Map();
let latestPendingDesktopCaptureSource = null;
let nextDesktopCapturePickerSessionId = 1;

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
  const maxWidth = getScreenQualityMaxWidth(qualityId);
  const pendingSource = {
    audioCapture,
    fps,
    maxHeight,
    maxWidth,
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
    maxWidth,
    qualityId,
    source
  };

  return audioCapture;
}

function recordGrantedDesktopCapture(frame, pending) {
  if (process.platform !== 'win32') return;
  const frameKey = getFrameScopeKey(frame);
  if (!frameKey || !pending?.source) return;
  grantedDesktopCaptureByFrame.set(frameKey, {
    fps: pending.fps || 30,
    grantedAt: Date.now(),
    maxHeight: pending.maxHeight || getScreenQualityMaxHeight(pending.qualityId),
    maxWidth: pending.maxWidth || getScreenQualityMaxWidth(pending.qualityId),
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

function takeLatestPendingDesktopCaptureSource() {
  if (!latestPendingDesktopCaptureSource || latestPendingDesktopCaptureSource.expiresAt < Date.now()) {
    latestPendingDesktopCaptureSource = null;
    return null;
  }

  const { audioCapture, fps, maxHeight, maxWidth, qualityId, source } = latestPendingDesktopCaptureSource;
  clearPendingDesktopCaptureSource(source.id);
  return { audioCapture, fps, maxHeight, maxWidth, qualityId, source };
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
      preload: path.join(__dirname, '../ui/screen-picker-preload.js'),
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
    pickerWindow.loadFile(path.join(__dirname, '../ui/screen-picker-preview.html'), {
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

module.exports = {
  cancelDesktopCapturePickerSession,
  clearPendingDesktopCaptureSource,
  getDesktopAudioCapabilities,
  getDesktopCapturePickerSessionForEvent,
  getDesktopCaptureSourceForSelection,
  getDesktopCaptureSources,
  isNativeOnlyScreenCaptureEligible,
  openDesktopCapturePickerWindow,
  peekPendingDesktopCaptureSource,
  recordGrantedDesktopCapture,
  rejectDesktopCapturePickerSession,
  resolveDesktopCapturePickerSession,
  serializeDesktopSource,
  setPendingDesktopCaptureSource,
  storeDesktopCaptureSourceSnapshot,
  takeGrantedDesktopCapture,
  takePendingDesktopCaptureSource
};
