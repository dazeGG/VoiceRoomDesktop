'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createRestartPolicy } = require('../electron/policies/native-capture-restart');

describe('native capture restart policy', () => {
  it('restarts only for non-zero exit codes other than unsupported (2)', () => {
    const policy = createRestartPolicy();
    assert.equal(policy.shouldRestart(1), true);
    assert.equal(policy.shouldRestart(0), false);
    assert.equal(policy.shouldRestart(2), false);
  });

  it('limits restarts to maxAttempts inside the sliding window', () => {
    let now = 1_000;
    const policy = createRestartPolicy({
      maxAttempts: 3,
      now: () => now,
      windowMs: 30_000
    });

    assert.equal(policy.shouldRestart(1), true);
    now += 1_000;
    assert.equal(policy.shouldRestart(1), true);
    now += 1_000;
    assert.equal(policy.shouldRestart(1), true);
    now += 1_000;
    assert.equal(policy.shouldRestart(1), false);
  });

  it('allows restarts again after the window elapses', () => {
    let now = 0;
    const policy = createRestartPolicy({
      maxAttempts: 1,
      now: () => now,
      windowMs: 10_000
    });

    assert.equal(policy.shouldRestart(1), true);
    assert.equal(policy.shouldRestart(1), false);
    now += 10_001;
    assert.equal(policy.shouldRestart(1), true);
  });
});