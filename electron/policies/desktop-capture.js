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
  ['high', 1080],
  ['source', 16384]
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

function getScreenQualityMaxHeight(qualityId) {
  return SCREEN_QUALITY_MAX_HEIGHTS.get(normalizeScreenQualityId(qualityId)) || 720;
}

function normalizeScreenFpsId(fpsId) {
  return SCREEN_FPS_IDS.has(fpsId) ? fpsId : DEFAULT_SCREEN_FPS_ID;
}

function normalizeDesktopCapturePickerSelection(selection) {
  return {
    fpsId: normalizeScreenFpsId(selection.fpsId),
    qualityId: normalizeScreenQualityId(selection.qualityId),
    sourceId: String(selection.sourceId || ''),
    streamAudioEnabled: selection.streamAudioEnabled !== false
  };
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
    maxHeight: getScreenQualityMaxHeight(qualityId),
    qualityId
  };
}

module.exports = {
  createScreenProfileId,
  getScreenQualityMaxHeight,
  normalizeApplyProfileRequest,
  normalizeDesktopAudioCapture,
  normalizeDesktopCapturePickerSelection,
  normalizeScreenFpsId,
  normalizeScreenQualityId
};
