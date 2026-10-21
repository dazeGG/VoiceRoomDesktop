'use strict';

/**
 * The admin app opens in the system browser, not in a window of this app.
 * The browser has no site session, so a plain admin URL ends on the 404.
 * The signed-in app asks the site for a one-time link and opens only that.
 * Someone who is not staff gets no link, and the browser stays closed.
 */

function pageOnAdmin(adminUrl) {
  try {
    const url = new URL(adminUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

/** The callback the site minted: the admin origin, the callback path, and a code. */
function isAdminCallback(rawUrl, adminOrigin) {
  if (!adminOrigin) return false;
  try {
    const url = new URL(rawUrl);
    return url.origin === adminOrigin && url.pathname === '/api/staff/callback' && Boolean(url.searchParams.get('code'));
  } catch {
    return false;
  }
}

async function openAdminInBrowser({ adminUrl, siteOrigin, adminOrigin, fetchEntry, openExternal, log = console }) {
  if (!siteOrigin || !adminOrigin) return false;
  const entry = new URL('/api/staff/browser-entry', siteOrigin);
  entry.searchParams.set('next', pageOnAdmin(adminUrl));
  let payload = null;
  try {
    payload = await fetchEntry(entry.toString());
  } catch (error) {
    log.warn?.('Failed to open the admin app:', error?.message || error);
    return false;
  }
  const target = payload && typeof payload.url === 'string' ? payload.url : '';
  if (!isAdminCallback(target, adminOrigin)) return false;
  try {
    await openExternal(target);
  } catch (error) {
    log.warn?.('Failed to open the admin app:', error?.message || error);
    return false;
  }
  return true;
}

module.exports = {
  isAdminCallback,
  openAdminInBrowser
};
