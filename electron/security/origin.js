'use strict';

const fs = require('node:fs');
const path = require('node:path');

let activeTrustedOrigin = '';

function setTrustedOrigin(trustedOrigin) {
  activeTrustedOrigin = typeof trustedOrigin === 'string' ? trustedOrigin : '';
}

function resolveTrustedOrigin(trustedOrigin) {
  return typeof trustedOrigin === 'string' ? trustedOrigin : activeTrustedOrigin;
}

function readRuntimeConfig() {
  const configPath = path.join(__dirname, '..', 'runtime-config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Canonical safe origin normalizer for both startup bootstrapping and
 * renderer/security trust checks. Invalid or missing URLs intentionally map
 * to an empty origin so callers can fail closed without crashing at import time.
 */
function getOriginFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return '';
  }
}

function isTrustedOrigin(origin, trustedOrigin) {
  const resolvedTrustedOrigin = resolveTrustedOrigin(trustedOrigin);
  return Boolean(resolvedTrustedOrigin) && origin === resolvedTrustedOrigin;
}

function isTrustedUrl(rawUrl, trustedOrigin) {
  const resolvedTrustedOrigin = resolveTrustedOrigin(trustedOrigin);
  try {
    return new URL(rawUrl).origin === resolvedTrustedOrigin;
  } catch {
    return false;
  }
}

/**
 * The admin app lives on the `admin.` subdomain of the trusted origin, with the
 * same scheme and port (https://voiceroom.ru → https://admin.voiceroom.ru). No
 * trusted origin, or one whose host takes no subdomain (an IP address), gives ''.
 */
function getAdminOrigin(trustedOrigin) {
  const resolvedTrustedOrigin = resolveTrustedOrigin(trustedOrigin);
  try {
    const trusted = new URL(resolvedTrustedOrigin);
    if (trusted.protocol !== 'https:' && trusted.protocol !== 'http:') return '';
    const admin = new URL(`${trusted.protocol}//admin.${trusted.host}`);
    return admin.hostname === `admin.${trusted.hostname}` ? admin.origin : '';
  } catch {
    return '';
  }
}

/** Where a URL belongs: the VoiceRoom site, its admin app, or anywhere else. */
function classifyAppUrl(rawUrl, trustedOrigin) {
  const resolvedTrustedOrigin = resolveTrustedOrigin(trustedOrigin);
  const origin = getOriginFromUrl(rawUrl);
  if (!resolvedTrustedOrigin || !origin || origin === 'null') return 'external';
  if (origin === resolvedTrustedOrigin) return 'site';
  if (origin === getAdminOrigin(resolvedTrustedOrigin)) return 'admin';
  return 'external';
}

function isAdminUrl(rawUrl, trustedOrigin) {
  return classifyAppUrl(rawUrl, trustedOrigin) === 'admin';
}

function isTrustedFrame(frame, trustedOrigin) {
  return Boolean(frame?.url && isTrustedUrl(frame.url, trustedOrigin));
}

function isTrustedDisplayMediaRequest(request, trustedOrigin) {
  return isTrustedFrame(request.frame, trustedOrigin) || isTrustedOrigin(request.securityOrigin, trustedOrigin);
}

function isTransitionalWebContentsUrl(rawUrl) {
  if (!rawUrl) return true;
  const normalized = rawUrl.trim().toLowerCase();
  return normalized === 'about:blank' || normalized.startsWith('about:');
}

function resolvePermissionContextOrigin(webContents, details = {}, requestingOrigin = '', trustedOrigin) {
  const resolvedTrustedOrigin = resolveTrustedOrigin(trustedOrigin);
  if (isTrustedOrigin(requestingOrigin, resolvedTrustedOrigin)) return requestingOrigin;

  const securityOrigin = typeof details.securityOrigin === 'string' ? details.securityOrigin : '';
  if (isTrustedOrigin(securityOrigin, resolvedTrustedOrigin)) return securityOrigin;

  const requestingUrlOrigin = getOriginFromUrl(details.requestingUrl);
  if (isTrustedOrigin(requestingUrlOrigin, resolvedTrustedOrigin)) return requestingUrlOrigin;

  if (!webContents || webContents.isDestroyed?.()) {
    return '';
  }

  const currentUrl = webContents.getURL();
  const currentOrigin = getOriginFromUrl(currentUrl);
  if (isTrustedOrigin(currentOrigin, resolvedTrustedOrigin)) return currentOrigin;
  if (isTransitionalWebContentsUrl(currentUrl) && resolvedTrustedOrigin) {
    return resolvedTrustedOrigin;
  }

  return '';
}

function isPermissionContextTrusted(webContents, details = {}, requestingOrigin = '', trustedOrigin) {
  return Boolean(resolvePermissionContextOrigin(webContents, details, requestingOrigin, trustedOrigin));
}

function isTrustedOrAppLoadingFrame(frame, trustedOrigin) {
  const resolvedTrustedOrigin = resolveTrustedOrigin(trustedOrigin);
  if (isTrustedFrame(frame, resolvedTrustedOrigin)) return true;
  return isTransitionalWebContentsUrl(frame?.url) && Boolean(resolvedTrustedOrigin);
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

module.exports = {
  classifyAppUrl,
  getAdminOrigin,
  getFrameKey,
  getFrameScopeKey,
  getOriginFromUrl,
  isAdminUrl,
  isPermissionContextTrusted,
  isTrustedDisplayMediaRequest,
  isTrustedFrame,
  isTrustedOrigin,
  isTrustedOrAppLoadingFrame,
  isTrustedUrl,
  isTransitionalWebContentsUrl,
  readRuntimeConfig,
  resolvePermissionContextOrigin,
  resolveTrustedOrigin,
  setTrustedOrigin
};
