'use strict';

const SITE_CHECK_TIMEOUT_MS = 15_000;

function formatUpdateErrorMessage() {
  return 'Не удалось проверить или загрузить обновление.';
}

function formatCheckingSiteMessage() {
  return 'Проверяем доступ к Voice Room...';
}

function formatSiteUnavailableMessage() {
  return 'Сайт Voice Room недоступен. Проверьте подключение к интернету.';
}

function isSiteAvailabilityStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

async function fetchWithTimeout(fetchImpl, url, { method, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    return await fetchImpl(url, {
      method,
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkSiteAvailability(appUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = SITE_CHECK_TIMEOUT_MS
} = {}) {
  if (!appUrl || typeof fetchImpl !== 'function') return false;

  try {
    const headResponse = await fetchWithTimeout(fetchImpl, appUrl, { method: 'HEAD', timeoutMs });
    if (isSiteAvailabilityStatus(headResponse.status) && headResponse.status !== 405) return true;
  } catch {
    // Retry with GET below: some static hosts/proxies reject HEAD even when the
    // actual app shell is reachable. The final state still reports site
    // availability explicitly instead of hiding the updater failure.
  }

  try {
    const getResponse = await fetchWithTimeout(fetchImpl, appUrl, { method: 'GET', timeoutMs });
    return isSiteAvailabilityStatus(getResponse.status);
  } catch {
    // Network errors, DNS failures, TLS errors, and timeouts all mean the app
    // shell is not reachable enough to offer the explicit enter-app button.
    return false;
  }
}

function createUpdateErrorState({ canProceed = true } = {}) {
  return {
    blocked: false,
    canProceed,
    message: canProceed
      ? `${formatUpdateErrorMessage()} Можно войти в приложение без обновления.`
      : `${formatUpdateErrorMessage()} Проверяем доступ к Voice Room...`,
    phase: 'update-error',
    progress: null
  };
}

function createSiteUnavailableState() {
  return {
    blocked: true,
    canProceed: false,
    message: formatSiteUnavailableMessage(),
    phase: 'site-unavailable',
    progress: null
  };
}

module.exports = {
  checkSiteAvailability,
  createSiteUnavailableState,
  createUpdateErrorState,
  isSiteAvailabilityStatus
};
