'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  checkSiteAvailability,
  createSiteUnavailableState,
  createUpdateErrorState,
  isSiteAvailabilityStatus
} = require('../electron/policies/update-gate-state');

describe('update gate site availability policy', () => {
  it('treats only successful or redirect app HTTP responses as site-available', () => {
    assert.equal(isSiteAvailabilityStatus(200), true);
    assert.equal(isSiteAvailabilityStatus(302), true);
    assert.equal(isSiteAvailabilityStatus(399), true);
    assert.equal(isSiteAvailabilityStatus(400), false);
    assert.equal(isSiteAvailabilityStatus(404), false);
    assert.equal(isSiteAvailabilityStatus(500), false);
    assert.equal(isSiteAvailabilityStatus(0), false);
  });

  it('uses HEAD success as site availability proof', async () => {
    const calls = [];
    const ok = await checkSiteAvailability('https://voiceroom.example', {
      fetchImpl: async (_url, options) => {
        calls.push(options.method);
        return { status: 200 };
      }
    });

    assert.equal(ok, true);
    assert.deepEqual(calls, ['HEAD']);
  });

  it('falls back to GET when HEAD is rejected', async () => {
    const calls = [];
    const ok = await checkSiteAvailability('https://voiceroom.example', {
      fetchImpl: async (_url, options) => {
        calls.push(options.method);
        if (options.method === 'HEAD') throw new Error('HEAD rejected');
        return { status: 200 };
      }
    });

    assert.equal(ok, true);
    assert.deepEqual(calls, ['HEAD', 'GET']);
  });

  it('falls back to GET when HEAD returns method-not-allowed', async () => {
    const calls = [];
    const ok = await checkSiteAvailability('https://voiceroom.example', {
      fetchImpl: async (_url, options) => {
        calls.push(options.method);
        if (options.method === 'HEAD') return { status: 405 };
        return { status: 200 };
      }
    });

    assert.equal(ok, true);
    assert.deepEqual(calls, ['HEAD', 'GET']);
  });

  it('treats app error responses as unavailable', async () => {
    const ok = await checkSiteAvailability('https://voiceroom.example', {
      fetchImpl: async () => ({ status: 404 })
    });

    assert.equal(ok, false);
  });

  it('returns unavailable when HEAD and GET fail', async () => {
    const ok = await checkSiteAvailability('https://voiceroom.example', {
      fetchImpl: async () => {
        throw new Error('offline');
      }
    });

    assert.equal(ok, false);
  });

  it('creates explicit updater-failed proceed and site-unavailable states', () => {
    assert.deepEqual(createUpdateErrorState({ canProceed: false }), {
      blocked: false,
      canProceed: false,
      message: 'Не удалось проверить или загрузить обновление. Проверяем доступ к Voice Room...',
      phase: 'update-error',
      progress: null
    });

    assert.deepEqual(createUpdateErrorState(), {
      blocked: false,
      canProceed: true,
      message: 'Не удалось проверить или загрузить обновление. Можно войти в приложение без обновления.',
      phase: 'update-error',
      progress: null
    });

    assert.deepEqual(createSiteUnavailableState(), {
      blocked: true,
      canProceed: false,
      message: 'Сайт Voice Room недоступен. Проверьте подключение к интернету.',
      phase: 'site-unavailable',
      progress: null
    });
  });
});
