'use strict';

const { VERSION } = require('./voice-frames');
const { exact, publicCode } = require('./voice-protocol');

const CHANNEL = 'desktop-native-voice:';
const MAX_COMMANDS = 16;
const START_REQUIRED = ['callId', 'url', 'token', 'tracks', 'outputDeviceId', 'muted'];
const START_KEYS = new Set([...START_REQUIRED, 'volumes', 'masterVolume']);
const TRACK_SID = /^TR_[a-zA-Z0-9_-]{1,125}$/;
const JWT = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function resolveVoiceOrigins(trustedOrigin, configured = '') {
  const origins = new Set();
  if (trustedOrigin.startsWith('https://')) origins.add(trustedOrigin.replace(/^https:/, 'wss:'));
  const site = /^https:\/\/(?:app\.)?((?:dev\.)?voiceroom\.ru)$/.exec(trustedOrigin)?.[1];
  if (site) {
    origins.add(`wss://livekit.${site}`);
    origins.add(`wss://livekit-fallback.${site}`);
  }
  for (const candidate of configured.split(',')) {
    const value = candidate.trim();
    try {
      const url = new URL(value);
      if (url.protocol === 'wss:' && (value === url.origin || value === `${url.origin}/`)) {
        origins.add(url.origin);
      }
    } catch {
      // Invalid entries leave the deployment allowlist unchanged.
    }
  }
  return origins;
}

const bounded = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);
const validCallId = (value) => bounded(value, 128) && value.trim() === value;
const validTracks = (value) => Array.isArray(value) && value.length <= 128
  && Array.from(value).every((track) => bounded(track, 128) && TRACK_SID.test(track))
  && new Set(value).size === value.length;
const validGain = (value) => Number.isFinite(value) && value >= 0 && value <= 2;
const validVolumes = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).length <= 128
  && Object.entries(value).every(([sid, gain]) => TRACK_SID.test(sid) && validGain(gain));
const validOutput = (value) => value === null || bounded(value, 512);
const rejected = (code) => ({ ok: false, code });
const untrustedFrame = () => Object.assign(new Error('untrusted-frame'), { code: 'untrusted-frame' });

function validUrl(value, origins) {
  if (!bounded(value, 4096) || !value.startsWith('wss://') || /[\s\\#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return origins.has(url.origin) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validStart(input, origins) {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && START_REQUIRED.every((key) => Object.hasOwn(input, key))
    && Object.keys(input).every((key) => START_KEYS.has(key))
    && validCallId(input.callId) && validUrl(input.url, origins)
    && bounded(input.token, 16384) && JWT.test(input.token)
    && validTracks(input.tracks) && validOutput(input.outputDeviceId) && typeof input.muted === 'boolean'
    && (!Object.hasOwn(input, 'volumes') || validVolumes(input.volumes))
    && (!Object.hasOwn(input, 'masterVolume') || validGain(input.masterVolume));
}

function validUpdate(input) {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && Object.hasOwn(input, 'callId') && validCallId(input.callId)
    && Object.keys(input).every((key) => {
      switch (key) {
        case 'callId': return true;
        case 'tracks': return validTracks(input.tracks);
        case 'volumes': return validVolumes(input.volumes);
        case 'masterVolume': return validGain(input.masterVolume);
        case 'outputDeviceId': return validOutput(input.outputDeviceId);
        case 'muted': return typeof input.muted === 'boolean';
        default: return false;
      }
    });
}

function rendererEvent({ kind, payload }) {
  switch (kind) {
    case 'media-ready': return { kind };
    case 'transport': return { kind, state: payload.state };
    case 'device': return {
      kind,
      outputDeviceId: payload.outputDevice,
      effectiveOutputDeviceId: payload.effectiveOutputDevice,
      defaultOutputDeviceId: payload.defaultOutputDevice,
      fallback: payload.fallback,
      muted: payload.muted
    };
    case 'stats': return {
      kind,
      jitterBufferDelaySeconds: payload.jitterBufferDelay,
      jitterBufferEmittedCount: payload.jitterBufferEmittedCount,
      concealedSamples: payload.concealedSamples,
      silentConcealedSamples: payload.silentConcealedSamples,
      concealmentEvents: payload.concealmentEvents,
      totalSamplesReceived: payload.totalSamplesReceived,
      packetsLost: payload.packetsLost,
      rttSeconds: payload.rtt,
      at: Date.now()
    };
  }
}

function createNativeVoiceIpc({
  ipcMain, isTrustedFrame, trustedOrigin, mediaOrigins, findVoiceHelper, startNativeVoice, stopNativeVoice
}) {
  const origins = resolveVoiceOrigins(trustedOrigin, mediaOrigins);
  let primary = null;
  let generation = 0;
  let accepting = false;
  let quitting = false;
  let current = null;
  let using = null;
  let draining;
  const retiring = new Map();
  let pending = 0;
  let tail = Promise.resolve();

  function enqueue(run) {
    pending += 1;
    const result = tail.then(run).finally(() => { pending -= 1; });
    tail = result.catch(() => {});
    return result;
  }

  function trusted(sender, frame) {
    return Boolean(!quitting && primary && sender === primary && frame
      && !sender.isDestroyed() && !frame.detached && frame === sender.mainFrame
      && frame.origin === trustedOrigin && isTrustedFrame(frame));
  }

  function scope(event) {
    if (!accepting || !trusted(event.sender, event.senderFrame)) throw untrustedFrame();
    return { sender: event.sender, frame: event.senderFrame, generation };
  }

  function stillCurrent(owner) {
    return accepting && owner.generation === generation && trusted(owner.sender, owner.frame);
  }

  function emit(owner, payload) {
    if (!stillCurrent(owner)) return;
    try {
      owner.frame.send(`${CHANNEL}event`, { callId: owner.callId, ...payload });
    } catch {
      // Electron may dispose the frame between the scope check and delivery.
    }
  }

  function stopHelper() {
    if (draining) return draining;
    const stopped = stopNativeVoice();
    if (!stopped) {
      using = null;
      return undefined;
    }
    const owner = using;
    const job = Promise.resolve(stopped).then((closed) => {
      if (closed !== false && using === owner) using = null;
      return closed;
    }).finally(() => {
      if (draining === job) draining = undefined;
    });
    draining = job;
    return job;
  }

  function retire(owner, code) {
    if (!owner || current !== owner) return owner?.retirement;
    current = null;
    const stopped = using === owner ? stopHelper() : draining;
    const job = Promise.resolve(stopped).then((closed) => {
      if (closed !== false && current?.callId !== owner.callId) {
        if (code) emit(owner, { kind: 'fault', code: publicCode(code) });
        emit(owner, { kind: 'stopped' });
      }
      return closed;
    }).finally(() => {
      if (retiring.get(owner.callId) === owner) retiring.delete(owner.callId);
    });
    owner.retirement = job;
    retiring.set(owner.callId, owner);
    return job;
  }

  function invalidate() {
    accepting = false;
    generation += 1;
    current = null;
    return stopHelper();
  }

  function attachWindow(window) {
    const webContents = window.webContents;
    if (primary && primary !== webContents) void invalidate();
    primary = webContents;
    accepting = true;
    webContents.on('did-start-navigation', (details) => {
      if (primary === webContents && details.isMainFrame && !details.isSameDocument) void invalidate();
    });
    const resume = () => {
      if (primary === webContents && !quitting) accepting = true;
    };
    webContents.on('did-navigate', () => {
      if (primary !== webContents || quitting) return;
      // A commit fences the old document even if a provisional load was interrupted.
      void invalidate();
      resume();
    });
    webContents.on('did-stop-loading', resume);
    webContents.on('render-process-gone', () => {
      if (primary === webContents) void invalidate();
    });
    const close = () => {
      if (primary !== webContents) return;
      primary = null;
      void invalidate();
    };
    webContents.once('destroyed', close);
    window.once('closed', close);
  }

  function configure() {
    ipcMain.on(`${CHANNEL}expose`, (event) => {
      event.returnValue = trusted(event.sender, event.senderFrame);
    });
    ipcMain.handle(`${CHANNEL}get-capability`, (event, ...args) => {
      scope(event);
      if (args.length) throw new Error('bad-payload');
      let available = false;
      try { available = Boolean(findVoiceHelper()); } catch {}
      return { available, protocol: VERSION, ...(available ? {} : { reason: 'helper-unavailable' }) };
    });
    ipcMain.handle(`${CHANNEL}list-outputs`, (event, ...args) => {
      const owner = scope(event);
      if (args.length) throw new Error('bad-payload');
      if (pending >= MAX_COMMANDS) throw new Error('too-many-requests');
      return enqueue(async () => {
        if (await draining === false) throw new Error('stop-timeout');
        if (!stillCurrent(owner)) throw untrustedFrame();
        const activeSession = current?.session;
        if (!activeSession) using = owner;
        try {
          const session = activeSession || await startNativeVoice();
          if (!stillCurrent(owner)) throw untrustedFrame();
          const { outputs } = await session.request('list-outputs');
          if (!stillCurrent(owner)) throw untrustedFrame();
          return outputs;
        } catch (error) {
          throw new Error(publicCode(error?.code));
        } finally {
          if (!activeSession) await stopHelper();
        }
      });
    });
    ipcMain.handle(`${CHANNEL}start`, (event, input, ...extra) => {
      const owner = scope(event);
      if (extra.length || !validStart(input, origins)) return rejected('bad-payload');
      if (pending >= MAX_COMMANDS) return rejected('too-many-requests');
      owner.callId = input.callId;
      owner.muted = input.muted;
      void retire(current);
      current = owner;
      return enqueue(async () => {
        if (await draining === false) {
          if (current === owner) current = null;
          return rejected('stop-timeout');
        }
        if (current !== owner || !stillCurrent(owner)) return rejected('session-stopped');
        using = owner;
        try {
          const session = await startNativeVoice({ callScoped: true });
          if (current !== owner || !stillCurrent(owner)) return rejected('session-stopped');
          owner.session = session;
          session.setRequestedMute(owner.muted);
          session.on('event', (frame) => {
            if (current === owner) emit(owner, rendererEvent(frame));
          });
          session.once('terminal', (code) => {
            if (current === owner) void retire(owner, code);
          });
          const { url, token, tracks, outputDeviceId, volumes, masterVolume } = input;
          await session.request('join', {
            url, token, tracks, outputDevice: outputDeviceId, muted: owner.muted, volumes, masterVolume
          }, { muteRecorded: true });
          return current === owner && stillCurrent(owner) ? { ok: true } : rejected('session-stopped');
        } catch (error) {
          await retire(owner, error?.code);
          return rejected(publicCode(error?.code));
        }
      });
    });
    ipcMain.handle(`${CHANNEL}update`, (event, input, ...extra) => {
      scope(event);
      if (extra.length || !validUpdate(input)) return rejected('bad-payload');
      const owner = current;
      if (owner?.callId !== input.callId) return rejected('stale-call');
      if (pending >= MAX_COMMANDS) return rejected('too-many-requests');
      if (input.muted !== undefined) {
        owner.muted = input.muted;
        owner.session?.setRequestedMute(input.muted);
      }
      return enqueue(async () => {
        if (current !== owner || !stillCurrent(owner) || !owner.session) return rejected('session-stopped');
        const { callId, outputDeviceId, ...payload } = input;
        if (outputDeviceId !== undefined) payload.outputDevice = outputDeviceId;
        if (!Object.keys(payload).length) return { ok: true };
        try {
          await owner.session.request('update', payload, { muteRecorded: true });
          return current === owner && stillCurrent(owner) ? { ok: true } : rejected('session-stopped');
        } catch (error) {
          await retire(owner, error?.code);
          return rejected(publicCode(error?.code));
        }
      });
    });
    ipcMain.handle(`${CHANNEL}stop`, async (event, input, ...extra) => {
      const caller = scope(event);
      if (extra.length || !exact(input, ['callId']) || !validCallId(input.callId)) throw new Error('bad-payload');
      const previous = retiring.get(input.callId);
      const stopped = current?.callId === input.callId ? retire(current)
        : previous?.generation === caller.generation ? previous.retirement
        : using?.callId === input.callId && using.generation === caller.generation ? stopHelper() : undefined;
      if (await stopped === false) throw new Error('stop-timeout');
    });
  }

  function stopForQuit() {
    quitting = true;
    return invalidate();
  }

  return { configure, attachWindow, stopForQuit };
}

module.exports = { createNativeVoiceIpc };
