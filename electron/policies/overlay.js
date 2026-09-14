'use strict';

const { bindingToAccelerator } = require('../hotkeys');

const OVERLAY_ANCHORS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const OVERLAY_AVATAR_SIZES = Object.freeze(['small', 'medium', 'large']);
const OVERLAY_MARGIN_PX = 16;
const OVERLAY_MIN_OPACITY = 0.2;
const OVERLAY_MAX_OPACITY = 1;
const OVERLAY_MAX_PARTICIPANTS = 8;
const OVERLAY_MAX_NAME_LENGTH = 40;
const OVERLAY_ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
const DEFAULT_INTERACTIVE_BINDING = Object.freeze({
  altKey: false,
  code: 'Backquote',
  ctrlKey: true,
  metaKey: false,
  shiftKey: false
});
const { sanitizeAllowedExecutables } = require('./overlay-games');

// Bumped when a stored field changes meaning. Version 2: `opacity` is the opacity of
// silent participants, not of the whole HUD.
const OVERLAY_SETTINGS_VERSION = 2;

const DEFAULT_OVERLAY_SETTINGS = Object.freeze({
  allowedExecutables: Object.freeze([]),
  anchor: 'top-left',
  avatarSize: 'medium',
  clickThrough: true,
  enabled: true,
  interactiveBinding: DEFAULT_INTERACTIVE_BINDING,
  // Opacity of participants who are not speaking; speakers are always fully opaque.
  opacity: 0.5,
  showControls: false,
  showNames: true,
  showParticipants: true,
  version: OVERLAY_SETTINGS_VERSION
});

function stripControlCharacters(value) {
  return Array.from(value).filter((char) => {
    const code = char.codePointAt(0);
    return code > 31 && code !== 127;
  }).join('');
}

function clampOpacity(value, fallback = DEFAULT_OVERLAY_SETTINGS.opacity) {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(OVERLAY_MAX_OPACITY, Math.max(OVERLAY_MIN_OPACITY, numeric));
}

function sanitizeInteractiveBinding(value) {
  if (value === null) return null;
  const source = value && typeof value === 'object' ? value : DEFAULT_INTERACTIVE_BINDING;
  const binding = {
    altKey: source.altKey === true,
    code: typeof source.code === 'string' ? source.code : '',
    ctrlKey: source.ctrlKey === true,
    metaKey: source.metaKey === true,
    shiftKey: source.shiftKey === true
  };
  const { accelerator } = bindingToAccelerator(binding);
  return accelerator ? Object.freeze(binding) : DEFAULT_INTERACTIVE_BINDING;
}

function sanitizeOverlaySettings(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const anchor = OVERLAY_ANCHORS.includes(source.anchor) ? source.anchor : DEFAULT_OVERLAY_SETTINGS.anchor;
  return Object.freeze({
    allowedExecutables: sanitizeAllowedExecutables(source.allowedExecutables),
    anchor,
    avatarSize: OVERLAY_AVATAR_SIZES.includes(source.avatarSize)
      ? source.avatarSize
      : DEFAULT_OVERLAY_SETTINGS.avatarSize,
    clickThrough: source.clickThrough !== false,
    enabled: source.enabled !== false,
    interactiveBinding: sanitizeInteractiveBinding(
      Object.hasOwn(source, 'interactiveBinding') ? source.interactiveBinding : DEFAULT_INTERACTIVE_BINDING
    ),
    // Older files stored the whole-HUD opacity, often 1, which hid who is speaking.
    opacity: source.version === OVERLAY_SETTINGS_VERSION
      ? clampOpacity(source.opacity)
      : DEFAULT_OVERLAY_SETTINGS.opacity,
    showControls: source.showControls === true,
    showNames: source.showNames !== false,
    showParticipants: source.showParticipants !== false,
    version: OVERLAY_SETTINGS_VERSION
  });
}

function sanitizeAvatarUrl(value, baseUrl = '') {
  if (typeof value !== 'string' || !value || value.length > 512) return '';
  try {
    // The API hands out same-origin paths such as /api/avatars/<key>. The overlay page
    // is a file:// document, so resolve them against the Voice Room URL.
    const relative = value.startsWith('/') && !value.startsWith('//');
    if (relative && !baseUrl) return '';
    const url = relative ? new URL(value, baseUrl) : new URL(value);
    if (url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function sanitizeAvatarAccent(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().slice(0, 80);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) return trimmed;
  if (/^oklch\([^)<>]{4,72}\)$/i.test(trimmed)) return trimmed;
  if (/^rgba?\([^)<>]{4,64}\)$/i.test(trimmed)) return trimmed;
  return '';
}

function sanitizeAvatarColorKey(value) {
  return typeof value === 'string' && /^[a-z]{1,16}$/.test(value) ? value : '';
}

function sanitizeOverlayParticipant(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.id !== 'string' || !OVERLAY_ID_PATTERN.test(payload.id)) return null;
  const name = typeof payload.name === 'string'
    ? stripControlCharacters(payload.name).trim().slice(0, OVERLAY_MAX_NAME_LENGTH)
    : '';
  return Object.freeze({
    avatarAccent: sanitizeAvatarAccent(payload.avatarAccent),
    avatarColorKey: sanitizeAvatarColorKey(payload.avatarColorKey),
    avatarUrl: sanitizeAvatarUrl(payload.avatarUrl, options.baseUrl),
    id: payload.id,
    micMuted: payload.micMuted === true,
    name,
    outputMuted: payload.outputMuted === true,
    self: payload.self === true,
    speaking: payload.speaking === true
  });
}

function sanitizeOverlaySnapshot(payload, options = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const raw = Array.isArray(source.participants) ? source.participants : [];
  const participants = [];
  const seen = new Set();
  for (const item of raw) {
    const participant = sanitizeOverlayParticipant(item, options);
    if (!participant || seen.has(participant.id)) continue;
    seen.add(participant.id);
    participants.push(participant);
    if (participants.length >= OVERLAY_MAX_PARTICIPANTS) break;
  }
  return Object.freeze({ participants: Object.freeze(participants) });
}

function shouldShowOverlay({
  callActive = false,
  enabled = true,
  gameActive = false,
  interactive = false,
  previewing = false
} = {}) {
  if (enabled !== true) return false;
  if (previewing === true) return true;
  if (callActive !== true) return false;
  if (interactive === true) return true;
  return gameActive === true;
}

function resolveOverlayBounds({
  anchor = DEFAULT_OVERLAY_SETTINGS.anchor,
  height,
  margin = OVERLAY_MARGIN_PX,
  width,
  workArea
} = {}) {
  const area = workArea && typeof workArea === 'object' ? workArea : { height: 720, width: 1280, x: 0, y: 0 };
  const sizeWidth = Math.max(1, Math.round(Number(width) || 1));
  const sizeHeight = Math.max(1, Math.round(Number(height) || 1));
  const gap = Number.isFinite(margin) ? Math.max(0, margin) : OVERLAY_MARGIN_PX;
  const left = Number.isFinite(area.x) ? area.x : 0;
  const top = Number.isFinite(area.y) ? area.y : 0;
  const areaWidth = Number.isFinite(area.width) ? area.width : sizeWidth + gap * 2;
  const areaHeight = Number.isFinite(area.height) ? area.height : sizeHeight + gap * 2;
  const maxX = left + Math.max(0, areaWidth - sizeWidth);
  const maxY = top + Math.max(0, areaHeight - sizeHeight);
  const right = Math.max(left, maxX - gap);
  const bottom = Math.max(top, maxY - gap);
  const originX = Math.min(maxX, left + gap);
  const originY = Math.min(maxY, top + gap);

  if (anchor === 'top-right') return { height: sizeHeight, width: sizeWidth, x: right, y: originY };
  if (anchor === 'bottom-left') return { height: sizeHeight, width: sizeWidth, x: originX, y: bottom };
  if (anchor === 'bottom-right') return { height: sizeHeight, width: sizeWidth, x: right, y: bottom };
  return { height: sizeHeight, width: sizeWidth, x: originX, y: originY };
}

function describeInteractiveHotkey(binding) {
  const { accelerator } = bindingToAccelerator(binding || DEFAULT_INTERACTIVE_BINDING);
  if (!accelerator) return 'Ctrl+`';
  return accelerator
    .replaceAll('Control', 'Ctrl')
    .replaceAll('Super', '⌘')
    .replaceAll('Command', '⌘');
}

function isOverlayHtmlUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  const normalized = rawUrl.replace(/\\/g, '/').split('?')[0];
  return normalized.endsWith('/overlay.html') || normalized.endsWith('/ui/overlay.html');
}

module.exports = {
  DEFAULT_INTERACTIVE_BINDING,
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_ANCHORS,
  OVERLAY_AVATAR_SIZES,
  OVERLAY_MARGIN_PX,
  OVERLAY_MAX_PARTICIPANTS,
  OVERLAY_SETTINGS_VERSION,
  describeInteractiveHotkey,
  isOverlayHtmlUrl,
  resolveOverlayBounds,
  sanitizeOverlaySettings,
  sanitizeOverlaySnapshot,
  shouldShowOverlay
};
