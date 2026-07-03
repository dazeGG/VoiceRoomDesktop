'use strict';

function createRestartPolicy({ maxAttempts = 3, windowMs = 30000, now = Date.now } = {}) {
  const attempts = [];

  function shouldRestart(exitCode) {
    if (exitCode === 0 || exitCode === 2) return false;

    const cutoff = now() - windowMs;
    while (attempts.length && attempts[0] < cutoff) {
      attempts.shift();
    }

    if (attempts.length >= maxAttempts) return false;

    attempts.push(now());
    return true;
  }

  return { shouldRestart };
}

module.exports = {
  createRestartPolicy
};