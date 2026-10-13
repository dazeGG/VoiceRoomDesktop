'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { DEFAULT_BACKOFF_MS, createRestartPolicy } = require('../electron/policies/native-capture-restart');

describe('native capture restart policy', () => {
  it('restarts only for non-zero exit codes other than unsupported (2)', () => {
    const policy = createRestartPolicy();
    assert.equal(policy.nextRestartDelay(1), 0);
    assert.equal(policy.nextRestartDelay(0), null);
    assert.equal(policy.nextRestartDelay(2), null);
  });

  it('restarts at once first, then backs off, then gives up', () => {
    const policy = createRestartPolicy({ backoffMs: [1_000, 5_000], maxAttempts: 3, now: () => 0 });

    assert.deepEqual(
      Array.from({ length: 6 }, () => policy.nextRestartDelay(1)),
      [0, 0, 0, 1_000, 5_000, null]
    );
  });

  it('treats an uncertain-profile kill (null exit code) as a failure', () => {
    const policy = createRestartPolicy({ backoffMs: [], maxAttempts: 1, now: () => 0 });
    assert.equal(policy.nextRestartDelay(null), 0);
    assert.equal(policy.nextRestartDelay(null), null);
  });

  it('refills the budget after a helper delivered frames long enough', () => {
    let now = 0;
    const policy = createRestartPolicy({ backoffMs: [], healthyMs: 30_000, maxAttempts: 1, now: () => now });

    assert.equal(policy.nextRestartDelay(1), 0);
    policy.noteHealthy();
    now += 29_999;
    assert.equal(policy.nextRestartDelay(1), null, 'a short run does not count as healthy');

    const healthy = createRestartPolicy({ backoffMs: [], healthyMs: 30_000, maxAttempts: 1, now: () => now });
    assert.equal(healthy.nextRestartDelay(1), 0);
    healthy.noteHealthy();
    now += 30_000;
    assert.equal(healthy.nextRestartDelay(1), 0);
  });

  it('keeps retrying for about a minute by default', () => {
    const total = DEFAULT_BACKOFF_MS.reduce((sum, delay) => sum + delay, 0);
    assert.ok(total >= 60_000 && total <= 90_000, `backoff budget is ${total} ms`);
  });
});
