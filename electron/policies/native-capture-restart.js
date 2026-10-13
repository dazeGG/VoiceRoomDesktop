'use strict';

// A GPU driver reset (TDR) takes the capture helper down for a few seconds and
// its first restarts fail at once, so a plain "N restarts per window" budget ends
// the stream before the device is back. The first restarts are immediate; then
// the helper is retried with growing pauses. The budget refills once a helper has
// delivered frames for `healthyMs`.
const DEFAULT_BACKOFF_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 15_000, 30_000]);

function createRestartPolicy({
  maxAttempts = 3,
  backoffMs = DEFAULT_BACKOFF_MS,
  healthyMs = 30_000,
  now = Date.now
} = {}) {
  let failures = 0;
  let healthySince = null;

  // Called whenever the running helper produces output.
  function noteHealthy() {
    if (healthySince === null) healthySince = now();
  }

  // Milliseconds to wait before the next restart, or null to give up.
  function nextRestartDelay(exitCode) {
    if (exitCode === 0 || exitCode === 2) return null;

    if (healthySince !== null && now() - healthySince >= healthyMs) failures = 0;
    healthySince = null;

    const attempt = failures;
    if (attempt >= maxAttempts + backoffMs.length) return null;
    failures += 1;
    return attempt < maxAttempts ? 0 : backoffMs[attempt - maxAttempts];
  }

  return { nextRestartDelay, noteHealthy };
}

module.exports = {
  DEFAULT_BACKOFF_MS,
  createRestartPolicy
};
