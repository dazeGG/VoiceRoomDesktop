'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { openAdminInBrowser } = require('../electron/window/open-admin');

const SITE = 'https://voiceroom.ru';
const ADMIN = 'https://admin.voiceroom.ru';

function harness(payload, { fail = false } = {}) {
  const opened = [];
  const asked = [];
  const result = openAdminInBrowser({
    adminUrl: `${ADMIN}/reports`,
    siteOrigin: SITE,
    adminOrigin: ADMIN,
    fetchEntry: async (entryUrl) => {
      asked.push(entryUrl);
      if (fail) throw new Error('offline');
      return payload;
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    log: { warn() {} }
  });
  return { asked, opened, result };
}

describe('admin app in the system browser', () => {
  it('opens the one-time callback the site minted for a staff member', async () => {
    const link = `${ADMIN}/api/staff/callback?code=once`;
    const { asked, opened, result } = harness({ ok: true, url: link });

    assert.equal(await result, true);
    assert.equal(asked.length, 1);
    const entry = new URL(asked[0]);
    assert.equal(entry.origin, SITE);
    assert.equal(entry.pathname, '/api/staff/browser-entry');
    assert.equal(entry.searchParams.get('next'), '/reports');
    assert.deepEqual(opened, [link]);
  });

  it('opens nothing when the account is not staff', async () => {
    const { opened, result } = harness({ ok: true, url: null });

    assert.equal(await result, false);
    assert.deepEqual(opened, []);
  });

  it('refuses a link that is not the admin callback', async () => {
    const { opened, result } = harness({ ok: true, url: 'https://evil.example/api/staff/callback?code=once' });

    assert.equal(await result, false);
    assert.deepEqual(opened, []);
  });

  it('opens nothing when the site cannot be asked', async () => {
    const { opened, result } = harness(null, { fail: true });

    assert.equal(await result, false);
    assert.deepEqual(opened, []);
  });
});
