'use strict';

const CHANNEL = 'desktop-notifications:show';
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 512;
const MAX_TAG_LENGTH = 128;
const MAX_DEDUPE_KEY_LENGTH = 128;
const MAX_ROUTE_LENGTH = 256;
const SHOW_TIMEOUT_MS = 15000;
const activeNotifications = new Set();

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

function describeNotificationError(error) {
  return String(error || 'Notification failed').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
}

function showDesktopNotification({ Notification, payload, restoreMainWindow }) {
  const sanitized = sanitizeNotificationPayload(payload);
  const notification = new Notification({
    body: sanitized.body || '',
    title: sanitized.title || 'Voice Room'
  });

  activeNotifications.add(notification);

  return new Promise((resolve) => {
    let settled = false;
    let timeout = 0;

    const finish = (result, keepAlive = false) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (!keepAlive) activeNotifications.delete(notification);
      resolve(result);
    };

    notification.on('show', () => {
      finish({ ok: true }, true);
    });
    notification.on('failed', (_event, error) => {
      finish({ ok: false, reason: 'failed', error: describeNotificationError(error) });
    });
    notification.on('click', () => {
      activeNotifications.delete(notification);
      restoreMainWindow();
    });
    notification.on('close', () => {
      activeNotifications.delete(notification);
    });

    timeout = setTimeout(() => {
      finish({ ok: false, reason: 'show-timeout' });
    }, SHOW_TIMEOUT_MS);

    try {
      notification.show();
    } catch (error) {
      finish({ ok: false, reason: 'show-threw', error: describeNotificationError(error?.message || error) });
    }
  });
}

function configureDesktopNotificationsIpc({ ipcMain, Notification, isTrustedFrame, restoreMainWindow }) {
  ipcMain.handle(CHANNEL, (event, payload = {}) => {
    if (!isTrustedFrame(event.senderFrame)) {
      throw new Error('Desktop notifications are only available for the configured Voice Room URL.');
    }

    if (!Notification?.isSupported?.()) {
      return { ok: false, reason: 'unsupported' };
    }

    return showDesktopNotification({ Notification, payload, restoreMainWindow });
  });
}

module.exports = {
  CHANNEL,
  activeNotifications,
  showDesktopNotification,
  sanitizeNotificationPayload,
  configureDesktopNotificationsIpc
};
