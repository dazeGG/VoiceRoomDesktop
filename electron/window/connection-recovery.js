'use strict';

// Keeps the main window from sitting empty when the site cannot be reached.
// Without this a failed load leaves Chromium's blank error page on the window's
// background colour, and a server that accepts the connection and never answers
// signals nothing at all until the app quits.
//
// Everything is driven by the window's own navigation events, so a page reload,
// a deep link and the launch itself are all covered the same way.

const STALLED_LOAD_MS = 15_000;
const RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 30_000];
const ERR_ABORTED = -3;
// Shorter than this is not worth a line in the server's logs.
const REPORTED_FROM_MS = 30_000;
// The computer may have slept between two checks, so at most this much of a gap counts.
const COUNTED_GAP_MS = 45_000;

const recoveries = new WeakMap();

function createConnectionRecovery({
  window,
  appUrl,
  isTrustedUrl,
  checkSite,
  showUnavailablePage,
  reportOutage = () => {},
  isOnline = () => true,
  log,
  now = Date.now
}) {
  const { webContents } = window;
  let target = appUrl;
  let outage = null;
  let stallTimer = null;
  let retryTimer = null;
  let checking = false;

  function clearStallTimer() {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  }

  function clearRetryTimer() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function countElapsed() {
    const at = now();
    outage.unreachableMs += Math.min(at - outage.lastSeenAt, COUNTED_GAP_MS);
    outage.lastSeenAt = at;
  }

  function scheduleRetry() {
    clearRetryTimer();
    const delay = RETRY_DELAYS_MS[Math.min(outage.attempts, RETRY_DELAYS_MS.length - 1)];
    retryTimer = setTimeout(retry, delay);
  }

  async function retry() {
    retryTimer = null;
    if (!outage || checking || window.isDestroyed()) return;
    checking = true;
    let available = false;
    try {
      available = await checkSite();
    } catch (error) {
      log?.warn?.('Checking the site failed:', error?.message || error);
    }
    checking = false;
    if (!outage || window.isDestroyed()) return;
    outage.attempts += 1;
    countElapsed();
    if (!available) {
      scheduleRetry();
      return;
    }
    // What comes of this load arrives as navigation events: did-navigate ends
    // the outage, and a failure or a stall comes back to markUnreachable.
    window.loadURL(target).catch(() => {});
  }

  function markUnreachable(reason, url) {
    clearStallTimer();
    if (url && isTrustedUrl(url)) target = url;
    if (!outage) {
      const at = now();
      outage = { startedAt: at, lastSeenAt: at, unreachableMs: 0, attempts: 0, reason, online: isOnline() };
      log?.warn?.('VoiceRoom is unreachable:', reason);
    }
    showUnavailablePage().catch((error) => {
      log?.error?.('Failed to open the connection screen:', error);
    });
    if (!checking) scheduleRetry();
  }

  function markReachable() {
    clearStallTimer();
    if (!outage) return;
    clearRetryTimer();
    countElapsed();
    const { unreachableMs, attempts, reason, online } = outage;
    outage = null;
    log?.info?.('VoiceRoom is reachable again after', unreachableMs, 'ms');
    if (unreachableMs >= REPORTED_FROM_MS) reportOutage({ durationMs: unreachableMs, attempts, reason, online });
  }

  webContents.on('did-start-navigation', (details) => {
    if (!details?.isMainFrame || details.isSameDocument || !isTrustedUrl(details.url)) return;
    clearStallTimer();
    target = details.url;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      markUnreachable('stalled', details.url);
    }, STALLED_LOAD_MS);
  });

  webContents.on('did-navigate', (_event, url, httpResponseCode) => {
    if (!isTrustedUrl(url)) return;
    if (httpResponseCode >= 500) markUnreachable(`http-${httpResponseCode}`, url);
    else markReachable();
  });

  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED || !isTrustedUrl(validatedUrl)) return;
    markUnreachable(errorDescription || `error-${errorCode}`, validatedUrl);
  });

  window.once('closed', () => {
    clearStallTimer();
    clearRetryTimer();
    outage = null;
  });

  const recovery = {
    isUnreachable: () => outage !== null,
    retryNow() {
      if (!outage) return Promise.resolve();
      clearRetryTimer();
      return retry();
    }
  };
  recoveries.set(window, recovery);
  return recovery;
}

function retryConnectionNow(window) {
  return recoveries.get(window)?.retryNow() ?? Promise.resolve();
}

// The site's own log intake: the outage never reached the server, so this is
// the only record of it there. Losing the report changes nothing for the user.
function createOutageReporter({ appUrl, fetchImpl, log, now = Date.now, randomId = () => Math.random().toString(36).slice(2, 10) }) {
  const sessionId = `desktop-${randomId()}`;
  return async function reportOutage({ durationMs, attempts, reason, online }) {
    try {
      const response = await fetchImpl(new URL('/api/client-logs', appUrl).href, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          events: [{
            at: now(),
            level: 'warn',
            ns: 'desktop:connection',
            msg: 'site was unreachable',
            ctx: { durationMs, attempts, reason, offline: !online }
          }]
        })
      });
      if (!response.ok) log?.warn?.('The server did not take the outage report:', response.status);
    } catch (error) {
      log?.warn?.('Failed to send the outage report:', error?.message || error);
    }
  };
}

module.exports = {
  createConnectionRecovery,
  createOutageReporter,
  retryConnectionNow
};
