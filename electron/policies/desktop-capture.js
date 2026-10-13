'use strict';

const DESKTOP_AUDIO_MODES = new Set([
  'none',
  'loopback',
  'safe-system',
  'application'
]);
const SCREEN_QUALITY_IDS = new Set(['low', 'balanced', 'high', 'source']);
const SCREEN_FPS_IDS = new Set(['5', '15', '30', '60']);
const DEFAULT_SCREEN_QUALITY_ID = 'balanced';
const DEFAULT_SCREEN_FPS_ID = '30';
const SCREEN_QUALITY_MAX_HEIGHTS = new Map([
  ['low', 540],
  ['balanced', 720],
  ['high', 1080]
]);
const SCREEN_QUALITY_MAX_WIDTHS = new Map([
  ['low', 960],
  ['balanced', 1280],
  ['high', 1920]
]);

function modeToCapabilityKey(mode) {
  if (mode === 'safe-system') return 'safeSystem';
  return mode;
}

function getSourceType(sourceId) {
  return String(sourceId || '').startsWith('screen:') ? 'screen' : 'window';
}

function normalizeDesktopAudioCapture(source, audioOptions, nativeCapabilities) {
  const options = typeof audioOptions === 'object' && audioOptions !== null
    ? audioOptions
    : { mode: audioOptions };
  const enabled = options.enabled !== false && options.mode !== 'none';
  const sourceType = getSourceType(source?.id);

  if (!enabled) {
    return {
      mode: 'none',
      requestedMode: 'none',
      sourceType,
      warning: ''
    };
  }

  const requestedMode = DESKTOP_AUDIO_MODES.has(options.mode) ? options.mode : 'safe-system';
  const safeModeRequested = requestedMode === 'safe-system' || requestedMode === 'application';
  if (safeModeRequested && nativeCapabilities.modes[modeToCapabilityKey(requestedMode)]) {
    return {
      mode: requestedMode,
      requestedMode,
      sourceType,
      warning: ''
    };
  }

  if (safeModeRequested && options.allowEchoFallback === false) {
    return {
      mode: 'none',
      requestedMode,
      sourceType,
      warning: 'safe-loopback-unavailable'
    };
  }

  return {
    mode: 'loopback',
    requestedMode,
    sourceType,
    warning: safeModeRequested ? 'using-echo-prone-loopback' : ''
  };
}

function createScreenProfileId(qualityId, fpsId) {
  return `${qualityId}-${fpsId}`;
}

function normalizeScreenQualityId(qualityId) {
  return SCREEN_QUALITY_IDS.has(qualityId) ? qualityId : DEFAULT_SCREEN_QUALITY_ID;
}

// Raw frames travel helper -> relay -> renderer as copies, so "source" still has a
// ceiling: 4K up to 30 fps, 1440p at 60 fps. Beyond that the copies cost far more
// than the encoder can use.
const SOURCE_HIGH_FPS_THRESHOLD = 30;
const SOURCE_MAX_SIZES = Object.freeze({
  highFps: Object.freeze({ height: 1440, width: 2560 }),
  standard: Object.freeze({ height: 2160, width: 3840 })
});

function getSourceMaxSize(fpsId) {
  return Number(fpsId) > SOURCE_HIGH_FPS_THRESHOLD ? SOURCE_MAX_SIZES.highFps : SOURCE_MAX_SIZES.standard;
}

function getScreenQualityMaxHeight(qualityId, fpsId) {
  const normalized = normalizeScreenQualityId(qualityId);
  if (normalized === 'source') return getSourceMaxSize(fpsId).height;
  return SCREEN_QUALITY_MAX_HEIGHTS.get(normalized) || 720;
}

function getScreenQualityMaxWidth(qualityId, fpsId) {
  const normalized = normalizeScreenQualityId(qualityId);
  if (normalized === 'source') return getSourceMaxSize(fpsId).width;
  return SCREEN_QUALITY_MAX_WIDTHS.get(normalized) || 1280;
}

function normalizeScreenFpsId(fpsId) {
  return SCREEN_FPS_IDS.has(fpsId) ? fpsId : DEFAULT_SCREEN_FPS_ID;
}

function normalizeDesktopCapturePickerSelection(selection) {
  const sourceId = String(selection.sourceId || '');
  const streamAudioEnabled = selection.streamAudioEnabled !== false;
  return {
    appAudioOnly: selection.appAudioOnly === true && streamAudioEnabled && getSourceType(sourceId) === 'window',
    fpsId: normalizeScreenFpsId(selection.fpsId),
    qualityId: normalizeScreenQualityId(selection.qualityId),
    sourceId,
    streamAudioEnabled
  };
}

// Electron window sources are "window:<HWND>:<n>" on Windows.
function getWindowSourceHandle(sourceId) {
  const match = /^window:(\d+):/.exec(String(sourceId || ''));
  const handle = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(handle) && handle > 0 ? handle : 0;
}

// Resolves a live-reconfigure request (quality/FPS) into the concrete capture
// parameters the native helper expects. Shared by the apply-profile IPC handler
// and its test so both exercise the same normalization.
function normalizeApplyProfileRequest(options = {}) {
  const qualityId = normalizeScreenQualityId(options.qualityId);
  const fpsId = normalizeScreenFpsId(options.fpsId);
  return {
    fps: Number(fpsId),
    fpsId,
    maxHeight: getScreenQualityMaxHeight(qualityId, fpsId),
    maxWidth: getScreenQualityMaxWidth(qualityId, fpsId),
    qualityId
  };
}

module.exports = {
  createScreenProfileId,
  getScreenQualityMaxHeight,
  getScreenQualityMaxWidth,
  getWindowSourceHandle,
  normalizeApplyProfileRequest,
  normalizeDesktopAudioCapture,
  normalizeDesktopCapturePickerSelection,
  normalizeScreenFpsId,
  normalizeScreenQualityId
};
