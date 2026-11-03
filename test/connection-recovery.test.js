'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { afterEach, beforeEach, describe, it, mock } = require('node:test');

const { createConnectionRecovery, createOutageReporter, retryConnectionNow } = require('../electron/window/connection-recovery');

const APP_URL = 'https://voiceroom.example/';
const isTrustedUrl = (url) => String(url).startsWith(APP_URL);

function setup({ siteAvailable = false } = {}) {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.isDestroyed = () => false;
  const loads = [];
  window.loadURL = async (url) => {
    loads.push(url);
  };

  const state = { siteAvailable, checks: 0, pages: 0, reports: [] };
  const recovery = createConnectionRecovery({
    window,
    appUrl: APP_URL,
    isTrustedUrl,
    checkSite: async () => {
      state.checks += 1;
      return state.siteAvailable;
    },
    showUnavailablePage: async () => {
      state.pages += 1;
    },
    reportOutage: (report) => state.reports.push(report),
    isOnline: () => true
  });

  return {
    window,
    recovery,
    state,
    loads,
    startNavigation: (url = APP_URL) =>
      window.webContents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false }),
    commit: (url = APP_URL, code = 200) => window.webContents.emit('did-navigate', {}, url, code),
    stopLoading: () => window.webContents.emit('did-stop-loading', {}),
    fail: (code = -118, description = 'ERR_CONNECTION_TIMED_OUT', url = APP_URL, isMainFrame = true) =>
      window.webContents.emit('did-fail-load', {}, code, description, url, isMainFrame)
  };
}

// Runs the timers that are due, then lets the check they started finish.
async function advance(ms) {
  mock.timers.tick(ms);
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe('connection recovery', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => mock.timers.reset());

  it('shows the connection screen when the load fails', () => {
    const { state, recovery, startNavigation, fail } = setup();
    startNavigation();
    fail();
    assert.equal(state.pages, 1);
    assert.equal(recovery.isUnreachable(), true);
  });

  it('shows the connection screen when a server accepts the connection and never answers', async () => {
    const { state, startNavigation } = setup();
    startNavigation();
    await advance(14_999);
    assert.equal(state.pages, 0);
    await advance(1);
    assert.equal(state.pages, 1);
  });

  it('leaves a load alone once the server has answered', async () => {
    const { state, startNavigation, commit } = setup();
    startNavigation();
    await advance(5_000);
    commit();
    await advance(60_000);
    assert.equal(state.pages, 0);
    assert.equal(state.checks, 0);
  });

  it('ignores what is not a failed load of the app itself', () => {
    const { state, recovery, startNavigation, fail } = setup();
    startNavigation();
    fail(-3, 'ERR_ABORTED');
    fail(-118, 'ERR_CONNECTION_TIMED_OUT', APP_URL, false);
    fail(-6, 'ERR_FILE_NOT_FOUND', 'file:///connection-lost.html');
    assert.equal(state.pages, 0);
    assert.equal(recovery.isUnreachable(), false);
  });

  it('does not watch navigation inside the page or to other sites', async () => {
    const { state, window } = setup();
    window.webContents.emit('did-start-navigation', { url: APP_URL, isMainFrame: true, isSameDocument: true });
    window.webContents.emit('did-start-navigation', { url: APP_URL, isMainFrame: false, isSameDocument: false });
    window.webContents.emit('did-start-navigation', { url: 'file:///x.html', isMainFrame: true, isSameDocument: false });
    await advance(60_000);
    assert.equal(state.pages, 0);
  });

  it('treats a server error for the page as unreachable', () => {
    const { state, recovery, commit } = setup();
    commit(APP_URL, 502);
    assert.equal(state.pages, 1);
    assert.equal(recovery.isUnreachable(), true);
  });

  it('keeps checking and returns to the page that failed once the site answers', async () => {
    const { state, loads, startNavigation, fail } = setup();
    const room = `${APP_URL}r/abc`;
    startNavigation(room);
    fail(-118, 'ERR_CONNECTION_TIMED_OUT', room);

    await advance(3_000);
    assert.equal(state.checks, 1);
    assert.deepEqual(loads, []);

    state.siteAvailable = true;
    await advance(6_000);
    assert.equal(state.checks, 2);
    assert.deepEqual(loads, [room]);
  });

  it('waits longer between checks, up to a limit', async () => {
    const { state, fail } = setup();
    fail();
    for (const [delay, checks] of [[3_000, 1], [6_000, 2], [12_000, 3], [30_000, 4], [30_000, 5]]) {
      await advance(delay - 1);
      assert.equal(state.checks, checks - 1);
      await advance(1);
      assert.equal(state.checks, checks);
    }
  });

  it('stops checking when the app is back', async () => {
    const { state, recovery, fail, commit } = setup();
    fail();
    commit();
    assert.equal(recovery.isUnreachable(), false);
    await advance(120_000);
    assert.equal(state.checks, 0);
  });

  it('goes back to the screen when the site answered the check but the load still fails', async () => {
    const { state, loads, recovery, fail } = setup({ siteAvailable: true });
    fail();
    await advance(3_000);
    assert.equal(loads.length, 1);

    fail();
    assert.equal(state.pages, 2);
    assert.equal(recovery.isUnreachable(), true);
    await advance(6_000);
    assert.equal(loads.length, 2);
  });

  it('checks at once when asked from the screen', async () => {
    const { window, state, loads, fail } = setup({ siteAvailable: true });
    fail();
    await retryConnectionNow(window);
    assert.equal(state.checks, 1);
    assert.equal(loads.length, 1);
    await advance(3_000);
    assert.equal(state.checks, 1, 'the scheduled check was replaced');
  });

  it('asks for nothing when there is no outage or no recovery for the window', async () => {
    const { window, state } = setup();
    await retryConnectionNow(window);
    await retryConnectionNow({});
    assert.equal(state.checks, 0);
  });

  it('reports a long outage once, with what it knows', async () => {
    const { state, fail, commit } = setup();
    fail();
    await advance(3_000);
    await advance(6_000);
    await advance(12_000);
    await advance(30_000);
    commit();
    commit();
    assert.deepEqual(state.reports, [
      { durationMs: 51_000, attempts: 4, reason: 'ERR_CONNECTION_TIMED_OUT', online: true }
    ]);
  });

  it('does not report a short outage', async () => {
    const { state, fail, commit } = setup();
    fail();
    await advance(3_000);
    commit();
    assert.deepEqual(state.reports, []);
  });

  it('does not count sleep as outage', async () => {
    const { state, fail, commit } = setup();
    fail();
    mock.timers.setTime(Date.now() + 8 * 60 * 60 * 1000);
    commit();
    assert.deepEqual(state.reports, []);
  });

  it('counts the longest real wait between two checks', async () => {
    const { state, fail, commit } = setup();
    fail();
    await advance(3_000);
    await advance(6_000);
    await advance(12_000);
    // The last delay of 30 seconds, then both requests of the check timing out.
    mock.timers.setTime(Date.now() + 60_000);
    commit();
    assert.equal(state.reports[0].durationMs, 81_000);
  });

  it('a navigation that ends without committing leaves the working page alone', async () => {
    const { state, recovery, loads, startNavigation, stopLoading } = setup({ siteAvailable: true });
    startNavigation(`${APP_URL}api/media/attachments/1/processed?download=1`);
    await advance(1_000);
    stopLoading();
    await advance(120_000);
    assert.equal(state.pages, 0);
    assert.equal(recovery.isUnreachable(), false);
    assert.deepEqual(loads, []);
  });

  it('a redirect to another site leaves the working page alone', async () => {
    const { state, startNavigation, commit } = setup();
    startNavigation();
    commit('https://elsewhere.example/');
    await advance(120_000);
    assert.equal(state.pages, 0);
  });

  it('a local screen opened during a load is not replaced by the stall', async () => {
    const { state, window, startNavigation } = setup();
    startNavigation();
    await advance(1_000);
    window.webContents.emit('did-start-navigation', {
      url: 'file:///renderer-recovery.html',
      isMainFrame: true,
      isSameDocument: false
    });
    await advance(120_000);
    assert.equal(state.pages, 0);
  });

  it('a page that keeps failing while the site is up gives way to the start page', async () => {
    const { loads, startNavigation, commit, fail } = setup({ siteAvailable: true });
    const room = `${APP_URL}r/broken`;
    startNavigation(room);
    fail(-118, 'ERR_CONNECTION_TIMED_OUT', room);

    await advance(3_000);
    assert.deepEqual(loads, [room], 'the page that failed gets the first try');

    commit(room, 502);
    await advance(6_000);
    assert.deepEqual(loads, [room, room], 'one failure may be a network flap');

    commit(room, 502);
    await advance(12_000);
    assert.deepEqual(loads, [room, room, room]);

    commit(room, 502);
    await advance(30_000);
    assert.deepEqual(loads, [room, room, room, APP_URL]);
  });

  it('a commit forgives the failed loads before it', async () => {
    const { loads, startNavigation, commit, fail } = setup({ siteAvailable: true });
    const room = `${APP_URL}r/abc`;
    for (let round = 0; round < 2; round += 1) {
      startNavigation(room);
      fail(-118, 'ERR_CONNECTION_TIMED_OUT', room);
      await advance(3_000);
      commit(room, 502);
      await advance(6_000);
      commit(room, 502);
      await advance(12_000);
      commit(room);
    }
    assert.deepEqual(loads, [room, room, room, room, room, room]);
  });

  it('a passed check does not cancel a load that is already on its way', async () => {
    const { state, loads, startNavigation, commit, fail } = setup({ siteAvailable: true });
    fail();
    const link = `${APP_URL}r/from-a-link`;
    startNavigation(link);

    await advance(3_000);
    assert.equal(state.checks, 1);
    assert.deepEqual(loads, []);

    commit(link);
    await advance(120_000);
    assert.deepEqual(loads, []);
    assert.equal(state.checks, 1);
  });

  it('a load during an outage that ends without committing is tried again', async () => {
    const { loads, stopLoading, fail } = setup({ siteAvailable: true });
    fail();
    await advance(3_000);
    assert.equal(loads.length, 1);

    stopLoading();
    await advance(6_000);
    assert.equal(loads.length, 2);
  });

  it('a page that failed for lack of a site is still returned to after more failures', async () => {
    const { state, loads, fail } = setup();
    const room = `${APP_URL}r/abc`;
    fail(-118, 'ERR_CONNECTION_TIMED_OUT', room);
    fail(-118, 'ERR_CONNECTION_TIMED_OUT', room);
    await advance(3_000);
    state.siteAvailable = true;
    await advance(6_000);
    assert.deepEqual(loads, [room]);
  });

  it('leaves the screen when the load it replaced committed first', async () => {
    const window = new EventEmitter();
    window.webContents = new EventEmitter();
    window.isDestroyed = () => false;
    const loads = [];
    window.loadURL = async (url) => loads.push(url);
    let screenShown;
    createConnectionRecovery({
      window,
      appUrl: APP_URL,
      isTrustedUrl,
      checkSite: async () => false,
      showUnavailablePage: () => new Promise((resolve) => {
        screenShown = resolve;
      })
    });

    window.webContents.emit('did-fail-load', {}, -118, 'ERR_CONNECTION_TIMED_OUT', APP_URL, true);
    window.webContents.emit('did-navigate', {}, APP_URL, 200);
    screenShown();
    await advance(0);
    assert.deepEqual(loads, [APP_URL]);
  });

  it('stops everything when the window closes', async () => {
    const { window, state, startNavigation, fail } = setup();
    fail();
    startNavigation();
    window.emit('closed');
    await advance(120_000);
    assert.equal(state.checks, 0);
    assert.equal(state.pages, 1);
  });
});

describe('outage report', () => {
  it('posts one record to the log intake with the session cookies', async () => {
    const calls = [];
    const report = createOutageReporter({
      appUrl: APP_URL,
      now: () => 1000,
      randomId: () => 'abc',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 202 };
      }
    });
    await report({ durationMs: 60_000, attempts: 3, reason: 'stalled', online: false });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${APP_URL}api/client-logs`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'include');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      sessionId: 'desktop-abc',
      events: [{
        at: 1000,
        level: 'warn',
        ns: 'desktop:connection',
        msg: 'site was unreachable',
        ctx: { durationMs: 60_000, attempts: 3, reason: 'stalled', offline: true }
      }]
    });
  });

  it('never throws when the report cannot be sent', async () => {
    const warnings = [];
    const log = { warn: (...args) => warnings.push(args) };
    const failing = createOutageReporter({
      appUrl: APP_URL,
      log,
      fetchImpl: async () => {
        throw new Error('offline');
      }
    });
    await failing({ durationMs: 1, attempts: 1, reason: 'stalled', online: true });

    const refused = createOutageReporter({ appUrl: APP_URL, log, fetchImpl: async () => ({ ok: false, status: 404 }) });
    await refused({ durationMs: 1, attempts: 1, reason: 'stalled', online: true });
    assert.equal(warnings.length, 2);
  });
});
