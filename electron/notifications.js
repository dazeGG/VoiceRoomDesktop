'use strict';

const CHANNEL = 'desktop-notifications:show';
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 512;
const MAX_TAG_LENGTH = 128;
const MAX_DEDUPE_KEY_LENGTH = 128;
const MAX_ROUTE_LENGTH = 256;

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

function sanitizeNotificationPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const sanitized = {};
  const title = sanitizeString(source.title, MAX_TITLE_LENGTH);
  const body = sanitizeString(source.body, MAX_BODY_LENGTH);
  const tag = sanitizeString(source.tag, MAX_TAG_LENGTH);
  const dedupeKey = sanitizeString(source.dedupeKey, MAX_DEDUPE_KEY_LENGTH);
  const route = sanitizeString(source.route, MAX_ROUTE_LENGTH);

  if (title) sanitized.title = title;
  if (body) sanitized.body = body;
  if (tag) sanitized.tag = tag;
  if (dedupeKey) sanitized.dedupeKey = dedupeKey;
  if (route) sanitized.route = route;

  return sanitized;
}

function configureDesktopNotificationsIpc({ ipcMain, Notification, isTrustedFrame, restoreMainWindow }) {
  ipcMain.handle(CHANNEL, (event, payload = {}) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop notifications are only available for the configured Voice Room URL.');
    }

    if (!Notification?.isSupported?.()) {
      return { ok: false, reason: 'unsupported' };
    }

    const sanitized = sanitizeNotificationPayload(payload);
    const notification = new Notification({
      body: sanitized.body || '',
      title: sanitized.title || 'Voice Room'
    });

    notification.on('click', () => {
      restoreMainWindow();
    });
    notification.show();

    return { ok: true };
  });
}

module.exports = {
  CHANNEL,
  sanitizeNotificationPayload,
  configureDesktopNotificationsIpc
};
