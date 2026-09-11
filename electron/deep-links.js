'use strict';

const STABLE_PROTOCOL_SCHEME = 'voiceroom';
const DEV_PROTOCOL_SCHEME = 'voiceroom-dev';
const OPEN_CHANNEL = 'desktop-links:open';
const READY_CHANNEL = 'desktop-links:ready';
const MAX_LINK_LENGTH = 2048;
// Mirrors extractRoomId() in the web client.
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{3,48}$/;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// How long a freshly loaded page may take to subscribe before the shell
// assumes an older web client without link support.
const SUBSCRIBE_GRACE_MS = 5000;

function resolveProtocolScheme({ isPackaged, buildProfile } = {}) {
  return isPackaged === true && buildProfile?.channel !== 'dev' ? STABLE_PROTOCOL_SCHEME : DEV_PROTOCOL_SCHEME;
}

function parseDeepLink(rawUrl, scheme = STABLE_PROTOCOL_SCHEME) {
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_LINK_LENGTH) return null;

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:`) return null;

  const segments = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
  if (segments.length === 2 && segments[0] === 'r' && ROOM_ID_PATTERN.test(segments[1])) {
    return { kind: 'room', roomId: segments[1], route: `/r/${segments[1]}` };
  }
  if (segments.length > 0) return null;

  const roomId = url.searchParams.get('room');
  const messageId = url.searchParams.get('message');
  if (roomId !== null || messageId !== null) {
    if (!ROOM_ID_PATTERN.test(roomId || '') || !ENTITY_ID_PATTERN.test(messageId || '')) return null;
    return { kind: 'mention', messageId, roomId, route: `/?room=${roomId}&message=${messageId}` };
  }

  const dmId = url.searchParams.get('dm');
  if (dmId !== null) {
    return ENTITY_ID_PATTERN.test(dmId) ? { dmId, kind: 'dm', route: `/?dm=${dmId}` } : null;
  }

  return { kind: 'app', route: '/' };
}

function findDeepLinkArgument(argv, scheme = STABLE_PROTOCOL_SCHEME) {
  if (!Array.isArray(argv)) return '';
  const prefix = `${scheme}:`;
  return argv.find((value) => typeof value === 'string' && value.toLowerCase().startsWith(prefix)) || '';
}

function resolveAppRouteUrl(appUrl, route = '/') {
  try {
    const base = new URL(appUrl);
    const target = new URL(route, base);
    return target.origin === base.origin ? target.toString() : base.toString();
  } catch {
    return appUrl;
  }
}

/**
 * Decides whether this build should own the protocol. Installed builds always
 * take it, the portable build only when nothing else has, and unpackaged runs
 * register the dev scheme against `electron .`.
 */
function resolveProtocolRegistration({
  appEntry = '',
  env = {},
  execPath = '',
  isClaimed = false,
  isPackaged,
  platform
}) {
  if (!isPackaged) return { args: appEntry ? [appEntry] : [], path: execPath, register: true };
  if (platform === 'win32' && env.PORTABLE_EXECUTABLE_FILE) {
    return isClaimed
      ? { register: false, reason: 'claimed' }
      : { args: [], path: env.PORTABLE_EXECUTABLE_FILE, register: true };
  }
  return { register: true };
}

function createDeepLinkController({
  app,
  appUrl,
  dialog,
  env = process.env,
  getMainWindow,
  isTrustedFrame,
  isVoiceActive = () => false,
  log = console,
  now = () => Date.now(),
  onWindowMissing = () => {},
  platform = process.platform,
  restoreMainWindow = () => {},
  scheme,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout
}) {
  // Per webContents: subscription flag, last load time and one pending link.
  const pages = new WeakMap();
  let initialLink = null;

  function pageState(webContents) {
    let state = pages.get(webContents);
    if (!state) {
      state = { loadedAt: 0, pending: null, subscribed: false, timer: null };
      pages.set(webContents, state);
      webContents.on('did-navigate', () => {
        // A new document must subscribe again; a link that was waiting for the
        // old one is replaced by whatever that navigation loads.
        state.subscribed = false;
        clearPending(state);
      });
      webContents.on('did-finish-load', () => {
        state.loadedAt = now();
        if (state.pending && !state.timer) startGraceTimer(webContents, state, SUBSCRIBE_GRACE_MS);
      });
    }
    return state;
  }

  function clearPending(state) {
    if (state.timer) cancel(state.timer);
    state.timer = null;
    state.pending = null;
  }

  function registerProtocol() {
    let isClaimed = false;
    try {
      isClaimed = Boolean(app.getApplicationNameForProtocol?.(`${scheme}://`));
    } catch {
      isClaimed = false;
    }
    const registration = resolveProtocolRegistration({
      appEntry: process.argv[1] ? require('node:path').resolve(process.argv[1]) : '',
      env,
      execPath: process.execPath,
      isClaimed,
      isPackaged: app.isPackaged,
      platform
    });
    if (!registration.register) {
      log.info?.(`Protocol ${scheme}:// is owned by another installation; the portable build leaves it.`);
      return false;
    }
    try {
      return registration.path
        ? app.setAsDefaultProtocolClient(scheme, registration.path, registration.args)
        : app.setAsDefaultProtocolClient(scheme);
    } catch (error) {
      log.warn?.(`Failed to register the ${scheme}:// protocol:`, error);
      return false;
    }
  }

  function parse(rawUrl) {
    const link = parseDeepLink(rawUrl, scheme);
    if (!link && rawUrl) log.warn?.('Ignoring unsupported deep link.');
    return link;
  }

  function captureInitialArgv(argv) {
    const link = parse(findDeepLinkArgument(argv, scheme));
    if (link) initialLink = link;
    return link;
  }

  function hasInitialLink() {
    return Boolean(initialLink);
  }

  function takeInitialUrl() {
    const link = initialLink;
    initialLink = null;
    return resolveAppRouteUrl(appUrl, link?.route || '/');
  }

  function navigate(window, link) {
    if (window.isDestroyed()) return;
    window.loadURL(resolveAppRouteUrl(appUrl, link.route)).catch((error) => {
      log.warn?.('Failed to open the deep link route:', error?.message || error);
    });
  }

  function fallback(window, link) {
    if (window.isDestroyed()) return;
    if (!isVoiceActive()) {
      navigate(window, link);
      return;
    }
    Promise.resolve(dialog.showMessageBox(window, {
      buttons: ['Перейти', 'Отмена'],
      cancelId: 1,
      defaultId: 0,
      detail: 'Текущий звонок прервётся.',
      message: 'Перейти по ссылке?',
      noLink: true,
      type: 'question'
    })).then(({ response }) => {
      if (response === 0) navigate(window, link);
    }).catch((error) => {
      log.warn?.('Deep link confirmation failed:', error);
    });
  }

  function startGraceTimer(webContents, state, delay) {
    if (state.timer) cancel(state.timer);
    state.timer = schedule(() => {
      state.timer = null;
      const link = state.pending;
      state.pending = null;
      const window = getMainWindow();
      if (link && window && window.webContents === webContents) fallback(window, link);
    }, Math.max(0, delay));
  }

  function deliver(window, link) {
    restoreMainWindow();
    const webContents = window.webContents;
    const state = pageState(webContents);
    if (state.subscribed) {
      webContents.send(OPEN_CHANNEL, link);
      return;
    }

    state.pending = link;
    if (webContents.isLoading()) return; // did-finish-load starts the grace period.
    const sinceLoad = state.loadedAt ? now() - state.loadedAt : SUBSCRIBE_GRACE_MS;
    startGraceTimer(webContents, state, SUBSCRIBE_GRACE_MS - sinceLoad);
  }

  function handleUrl(rawUrl) {
    const link = parse(rawUrl);
    const window = getMainWindow();
    if (!window) {
      if (link) initialLink = link;
      onWindowMissing();
      return;
    }
    if (!link) {
      restoreMainWindow();
      return;
    }
    deliver(window, link);
  }

  function handleArgv(argv) {
    const rawUrl = findDeepLinkArgument(argv, scheme);
    if (rawUrl) handleUrl(rawUrl);
  }

  function attachWindow(window) {
    const state = pageState(window.webContents);
    state.loadedAt = 0;
  }

  function configureIpc({ ipcMain }) {
    ipcMain.handle(READY_CHANNEL, (event) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('Desktop links are only available for the configured Voice Room URL.');
      }
      const state = pageState(event.sender);
      state.subscribed = true;
      const link = state.pending;
      clearPending(state);
      if (link) event.sender.send(OPEN_CHANNEL, link);
      return { ok: true, scheme };
    });
  }

  return {
    attachWindow,
    captureInitialArgv,
    configureIpc,
    handleArgv,
    handleUrl,
    hasInitialLink,
    registerProtocol,
    takeInitialUrl
  };
}

module.exports = {
  DEV_PROTOCOL_SCHEME,
  OPEN_CHANNEL,
  READY_CHANNEL,
  STABLE_PROTOCOL_SCHEME,
  SUBSCRIBE_GRACE_MS,
  createDeepLinkController,
  findDeepLinkArgument,
  parseDeepLink,
  resolveAppRouteUrl,
  resolveProtocolRegistration,
  resolveProtocolScheme
};
