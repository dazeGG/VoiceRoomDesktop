'use strict';

const NATIVE_CAPTURE_PROTOCOL_VERSION = 2;
const NATIVE_CAPTURE_PORT_MESSAGE_TYPE = 'voice-room-native-capture-port';

function hasChromiumAudioRequest(constraints) {
  if (!constraints || typeof constraints !== 'object') return false;
  return Boolean(constraints.audio);
}

function isNativeOnlyDisplayMediaCandidate(constraints, capabilities = {}) {
  // Chromium loopback audio can only be obtained through the original
  // getDisplayMedia stream. Safe-system audio is started through the desktop
  // audio bridge, so video-only getDisplayMedia calls may skip Chromium video
  // capture entirely.
  return capabilities.mediaStreamAvailable !== false && !hasChromiumAudioRequest(constraints);
}

function isCompatibleNativeCaptureSession(session) {
  return Boolean(session?.ok && session.protocolVersion === NATIVE_CAPTURE_PROTOCOL_VERSION);
}

function normalizeReconfigureCommand(message) {
  if (!message || message.type !== 'reconfigure') return null;

  const fps = Number.isInteger(message.fps) && message.fps > 0 && message.fps <= 60
    ? message.fps
    : null;
  const maxHeight = Number.isInteger(message.maxHeight) && message.maxHeight >= 2 && message.maxHeight <= 16384
    ? message.maxHeight
    : null;
  const maxWidth = Number.isInteger(message.maxWidth) && message.maxWidth >= 2 && message.maxWidth <= 16384
    ? message.maxWidth
    : null;

  if (fps === null && maxHeight === null && maxWidth === null) return null;
  return { fps, maxHeight, maxWidth };
}

function buildReconfigureStdinPayload(session, command) {
  return {
    cmd: 'reconfigure',
    fps: command.fps ?? session.fps,
    maxHeight: command.maxHeight ?? session.maxHeight,
    maxWidth: command.maxWidth ?? session.maxWidth
  };
}

module.exports = {
  NATIVE_CAPTURE_PORT_MESSAGE_TYPE,
  NATIVE_CAPTURE_PROTOCOL_VERSION,
  buildReconfigureStdinPayload,
  hasChromiumAudioRequest,
  isCompatibleNativeCaptureSession,
  isNativeOnlyDisplayMediaCandidate,
  normalizeReconfigureCommand
};
