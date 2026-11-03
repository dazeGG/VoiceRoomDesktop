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
// Longer than any wait between two checks (the delay, then two requests of 15
// seconds): such a gap is a computer that slept, and it does not count at all.
const SLEEP_GAP_MS = 75_000;
// Loads that failed although the check before each one passed. One is a network
// flap, and giving up on it would lose a room or a one-time link; this many means
// the page itself is broken.
const FAILED_LOADS_BEFORE_START_PAGE = 3;

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
  // The site answered the check and this load followed from it.
  let loadingAfterCheck = false;
  let failedLoadsAfterCheck = 0;

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
    const gap = at - outage.lastSeenAt;
    if (gap <= SLEEP_GAP_MS) outage.unreachableMs += gap;
    outage.lastSeenAt = at;
  }

  function scheduleRetry() {
    clearRetryTimer();
    const delay = RETRY_DELAYS_MS[Math.min(outage.attempts, RETRY_DELAYS_MS.length - 1)];
    retryTimer = setTimeout(retry, delay);
  }

  function loadTarget() {
    // What comes of this load arrives as navigation events: did-navigate ends
    // the outage, and a failure or a stall comes back to markUnreachable.
    window.loadURL(target).catch(() => {});
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
    // Something is already on its way, a deep link say, and loading now would cancel it.
    if (stallTimer) {
      scheduleRetry();
      return;
    }
    loadingAfterCheck = true;
    loadTarget();
  }

  function markUnreachable(reason, url) {
    clearStallTimer();
    if (loadingAfterCheck) failedLoadsAfterCheck += 1;
    loadingAfterCheck = false;
    // The site is up and this page still will not load, so it is the page: the
    // start page gets the user out instead of a screen about their internet.
    if (failedLoadsAfterCheck >= FAILED_LOADS_BEFORE_START_PAGE) target = appUrl;
    else if (url && isTrustedUrl(url)) target = url;
    if (!outage) {
      const at = now();
      outage = { lastSeenAt: at, unreachableMs: 0, attempts: 0, reason, online: isOnline() };
      log?.warn?.('VoiceRoom is unreachable:', reason);
    }
    showUnavailablePage().then(() => {
      // The load it was replacing got through first, so nothing would ever
      // leave this screen.
      if (!outage && !window.isDestroyed()) loadTarget();
    }).catch((error) => {
      log?.error?.('Failed to open the connection screen:', error);
    });
    if (!checking) scheduleRetry();
  }

  function markReachable() {
    loadingAfterCheck = false;
    failedLoadsAfterCheck = 0;
    if (!outage) return;
    clearRetryTimer();
    countElapsed();
    const { unreachableMs, attempts, reason, online } = outage;
    outage = null;
    log?.info?.('VoiceRoom is reachable again after', unreachableMs, 'ms');
    if (unreachableMs >= REPORTED_FROM_MS) reportOutage({ durationMs: unreachableMs, attempts, reason, online });
  }

  webContents.on('did-start-navigation', (details) => {
    if (!details?.isMainFrame || details.isSameDocument) return;
    clearStallTimer();
    if (!isTrustedUrl(details.url)) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      markUnreachable('stalled', details.url);
    }, STALLED_LOAD_MS);
  });

  // A navigation may end without committing: a download, a 204, a redirect that
  // was refused, window.stop(). A load that is really stuck never gets here.
  webContents.on('did-stop-loading', () => {
    clearStallTimer();
    // A load during an outage ended that way, and nothing else would try again.
    if (outage && !retryTimer && !checking) scheduleRetry();
  });

  webContents.on('did-navigate', (_event, url, httpResponseCode) => {
    clearStallTimer();
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
