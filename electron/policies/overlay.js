'use strict';

const { sanitizeAllowedExecutables } = require('./overlay-games');

const OVERLAY_ANCHORS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const OVERLAY_AVATAR_SIZES = Object.freeze(['small', 'medium', 'large']);
const OVERLAY_MARGIN_PX = 16;
const OVERLAY_MAX_PARTICIPANTS = 8;
const OVERLAY_MAX_NAME_LENGTH = 40;
const OVERLAY_ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;

// The HUD always lets clicks through and always fades silent participants to 50 %,
// so only these preferences are stored.
const DEFAULT_OVERLAY_SETTINGS = Object.freeze({
  allowedExecutables: Object.freeze([]),
  anchor: 'top-left',
  avatarSize: 'medium',
  enabled: true,
  showNames: true
});

function stripControlCharacters(value) {
  return Array.from(value).filter((char) => {
    const code = char.codePointAt(0);
    return code > 31 && code !== 127;
  }).join('');
}

function sanitizeOverlaySettings(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return Object.freeze({
    allowedExecutables: sanitizeAllowedExecutables(source.allowedExecutables),
    anchor: OVERLAY_ANCHORS.includes(source.anchor) ? source.anchor : DEFAULT_OVERLAY_SETTINGS.anchor,
    avatarSize: OVERLAY_AVATAR_SIZES.includes(source.avatarSize)
      ? source.avatarSize
      : DEFAULT_OVERLAY_SETTINGS.avatarSize,
    enabled: source.enabled !== false,
    showNames: source.showNames !== false
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
    speaking: payload.speaking === true,
    streaming: payload.streaming === true
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
  previewing = false
} = {}) {
  if (enabled !== true) return false;
  if (previewing === true) return true;
  if (callActive !== true) return false;
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

// A window covers the game when their rectangles overlap. The inset ignores the
// invisible resize borders that maximized windows push past the monitor edge.
function boundsOverlap(front, game, inset = 16) {
  if (!front || !game) return false;
  const left = Math.max(front.x + inset, game.x);
  const right = Math.min(front.x + front.width - inset, game.x + game.width);
  const top = Math.max(front.y + inset, game.y);
  const bottom = Math.min(front.y + front.height - inset, game.y + game.height);
  return right > left && bottom > top;
}

function isOverlayHtmlUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  const normalized = rawUrl.replace(/\\/g, '/').split('?')[0];
  return normalized.endsWith('/overlay.html') || normalized.endsWith('/ui/overlay.html');
}

module.exports = {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_ANCHORS,
  OVERLAY_AVATAR_SIZES,
  OVERLAY_MARGIN_PX,
  OVERLAY_MAX_PARTICIPANTS,
  boundsOverlap,
  isOverlayHtmlUrl,
  resolveOverlayBounds,
  sanitizeOverlaySettings,
  sanitizeOverlaySnapshot,
  shouldShowOverlay
};
