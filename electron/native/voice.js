'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createDecoder, encode, VERSION } = require('./voice-frames');
const { exact, isHello, isReady, isEvent, isReply, isError } = require('./voice-protocol');

const REQUEST_TIMEOUT_MS = 2500;
const JOIN_TIMEOUT_MS = 12000;
const RESTART_COOLDOWN_MS = 30000;
// The renderer gives stop IPC one second before restoring Chromium playback.
const SHUTDOWN_GRACE_MS = 500;
const SHUTDOWN_DEADLINE_MS = 800;
let lastRestart = -Infinity;

function findVoiceHelper({
  appPath = path.resolve(__dirname, '..', '..'),
  resourcesPath = process.resourcesPath,
  platform = process.platform,
  arch = process.arch
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') return null;
  const relative = path.join('native', 'bin', 'windows', 'VoiceRoomVoice.exe');
  const candidates = resourcesPath
    ? [path.join(resourcesPath, 'app.asar.unpacked', relative), path.join(resourcesPath, relative)]
    : [];
  candidates.push(path.join(appPath, relative));
  return candidates.find((file) => path.isAbsolute(file)
    && !file.split(path.sep).includes('app.asar')
    && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) || null;
}

function fault(code) {
  return Object.assign(new Error(code), { code });
}

function terminate(child) {
  try {
    child.kill();
  } catch {
    // The parent watchdog is the fallback if Windows refuses termination.
  }
}

class VoiceSession extends EventEmitter {
  constructor(helper, {
    callScoped = false,
    spawnChild = spawn,
    handshakeMs = 4000,
    heartbeatMs = 1000,
    heartbeatTimeoutMs = REQUEST_TIMEOUT_MS,
    restartDelayMs = 500,
    restartCooldownMs = RESTART_COOLDOWN_MS,
    shutdownGraceMs = SHUTDOWN_GRACE_MS,
    shutdownDeadlineMs = SHUTDOWN_DEADLINE_MS
  } = {}) {
    super();
    this.helper = helper;
    this.callScoped = callScoped;
    this.spawnChild = spawnChild;
    this.handshakeMs = handshakeMs;
    this.heartbeatMs = heartbeatMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.restartDelayMs = restartDelayMs;
    this.restartCooldownMs = restartCooldownMs;
    this.shutdownGraceMs = shutdownGraceMs;
    this.shutdownDeadlineMs = shutdownDeadlineMs;
    this.restarts = 0;
    this.stopping = false;
    this.connection = null;
    this.requestedMute = true;
    this.restartTimer = null;
  }

  async start() {
    const epoch = randomUUID();
    const child = this.spawnChild(this.helper, [epoch, String(process.pid)], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const pending = new Map();
    let resolveReady;
    let rejectReady;
    let resolveExit;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const connection = {
      child, epoch, pending, exited, phase: 'hello', nextId: 1,
      heartbeat: null, failing: false, failure: null
    };
    this.connection = connection;
    const fail = (code, terminal = false) => {
      if (connection.failing) return;
      connection.failing = true;
      connection.failure = code;
      connection.terminal = terminal;
      rejectReady(fault(code));
      terminate(child);
    };
    const handshake = setTimeout(() => fail('handshake-timeout'), this.handshakeMs);
    const read = createDecoder((frame) => {
      if (this.connection !== connection || connection.failing) return;
      if (!exact(frame, ['v', 'epoch', 'id', 'kind', 'payload'])
          || !exact(frame.v, ['major', 'minor']) || typeof frame.epoch !== 'string'
          || !Number.isInteger(frame.id) || frame.id < 0 || frame.id > 0xffffffff
          || typeof frame.kind !== 'string') {
        fail('bad-frame');
        return;
      }
      if (frame.v.major !== VERSION.major || frame.v.minor !== VERSION.minor) {
        fail('version-mismatch');
        return;
      }
      if (frame.epoch !== epoch) return;
      if (connection.phase === 'hello' && frame.id === 0 && frame.kind === 'hello' && isHello(frame.payload)) {
        connection.phase = 'ready';
        this.capabilities = Object.freeze(frame.payload.capabilities);
        return;
      }
      if (connection.phase === 'ready' && frame.kind === 'ready' && frame.id === 0 && isReady(frame.payload)) {
        clearTimeout(handshake);
        connection.phase = 'running';
        resolveReady(this.capabilities);
        return;
      }
      if (connection.phase !== 'running') {
        fail('bad-handshake');
        return;
      }
      if (frame.id === 0) {
        if (frame.kind === 'fault') {
          const code = exact(frame.payload, ['code']) && frame.payload.code;
          if (code === 'output-not-rendering') fail(code, true);
          else fail(['bad-frame', 'frame-size'].includes(code) ? 'helper-fault' : 'bad-event');
          return;
        }
        if (!isEvent(frame.kind, frame.payload)) {
          fail('bad-event');
          return;
        }
        if (!this.stopping) this.emit('event', frame);
        return;
      }
      const request = pending.get(frame.id);
      if (!request || request.kind !== frame.payload?.command
          || !(frame.kind === 'response' && isReply(request.kind, frame.payload)
            || frame.kind === 'error' && isError(request.kind, frame.payload))) {
        fail('bad-response');
        return;
      }
      clearTimeout(request.timer);
      pending.delete(frame.id);
      if (frame.kind === 'response') request.resolve(frame.payload.data);
      else {
        if (frame.payload.code === 'device-switch-failed') this.setRequestedMute(true);
        request.reject(fault(frame.payload.code));
      }
    });
    child.stdout.on('data', (chunk) => {
      try {
        read(chunk);
      } catch {
        fail('bad-frame');
      }
    });
    child.stdout.on('error', () => fail('pipe-error'));
    child.stdin.on('error', () => {
      if (!this.stopping) fail('pipe-error');
    });
    child.on('error', () => fail('spawn-error'));
    child.once('close', () => {
      clearTimeout(handshake);
      clearInterval(connection.heartbeat);
      const error = fault(connection.failure || 'helper-exited');
      rejectReady(error);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
      resolveExit();
      if (this.connection !== connection) return;
      this.connection = null;
      if (!this.stopping) this.recover(error.code, connection.terminal);
    });
    connection.fail = fail;
    await ready;
    if (this.connection !== connection || this.stopping) throw fault('session-stopped');
    connection.heartbeat = setInterval(() => {
      // Join has its own bounded deadline and serializes commands in the helper.
      if (this.stopping || connection.failing || pending.size) return;
      this.send(connection, 'ping', {}, this.heartbeatTimeoutMs).catch(() => fail('heartbeat-lost'));
    }, this.heartbeatMs);
    return this.capabilities;
  }

  recover(code, terminal) {
    this.emit('lost', code);
    if (this.stopping) return;
    const now = performance.now();
    if (this.callScoped || terminal || this.restarts || now - lastRestart < this.restartCooldownMs) {
      this.finishRecovery(false);
      this.emit('terminal', code);
      return;
    }
    this.restarts += 1;
    lastRestart = now;
    this.recovery = Promise.withResolvers();
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.start();
        if (!this.stopping) {
          this.finishRecovery(true);
          this.emit('restarted');
        }
      } catch {
        if (this.connection) this.connection.fail('restart-failed');
        else if (!this.stopping && this.recovery) {
          this.finishRecovery(false);
          this.emit('terminal', 'restart-failed');
        }
      }
    }, this.restartDelayMs);
  }

  finishRecovery(restarted) {
    this.recovery?.resolve(restarted);
    this.recovery = null;
  }

  setRequestedMute(muted) {
    this.requestedMute = muted;
  }

  send(connection, kind, payload, timeout = kind === 'join' ? JOIN_TIMEOUT_MS : REQUEST_TIMEOUT_MS) {
    if (!connection || connection.phase !== 'running' || connection.failing) {
      return Promise.reject(fault('helper-unavailable'));
    }
    if (connection.pending.size >= 16) return Promise.reject(fault('too-many-requests'));
    const id = connection.nextId++;
    let frame;
    try {
      frame = encode({ v: VERSION, epoch: connection.epoch, id, kind, payload });
    } catch {
      return Promise.reject(fault('bad-payload'));
    }
    return new Promise((resolve, reject) => {
      // Shutdown has its own drain and termination deadlines.
      const timer = kind === 'shutdown' ? null : setTimeout(() => {
        connection.fail(kind === 'ping' ? 'heartbeat-lost' : 'request-timeout');
      }, timeout);
      connection.pending.set(id, { timer, kind, resolve, reject });
      connection.child.stdin.write(frame, (error) => {
        if (error && !this.stopping) connection.fail('pipe-error');
      });
    });
  }

  async request(kind, payload = {}, { muteRecorded = false } = {}) {
    if (this.stopping || kind === 'shutdown') throw fault('session-stopped');
    if (!['join', 'leave', 'ping', 'subscriptions', 'output-mute', 'output-device', 'list-outputs', 'update'].includes(kind)) {
      throw fault('unknown-command');
    }
    let snapshot;
    try {
      snapshot = structuredClone(payload);
    } catch {
      throw fault('bad-payload');
    }
    // A join makes the helper single-use even if it exits before acknowledging admission.
    if (kind === 'join') this.callScoped = true;
    if (!muteRecorded) {
      if (kind === 'join') this.setRequestedMute(snapshot?.muted ?? true);
      else if (['update', 'output-mute'].includes(kind) && typeof snapshot?.muted === 'boolean') {
        this.setRequestedMute(snapshot.muted);
      }
    }
    if (this.recovery && !(await this.recovery.promise)) throw fault('helper-unavailable');
    if (this.stopping) throw fault('session-stopped');
    if (typeof snapshot?.muted === 'boolean') {
      if (kind === 'update' && snapshot.muted !== this.requestedMute) delete snapshot.muted;
      else snapshot.muted = this.requestedMute;
    }
    return this.send(this.connection, kind, snapshot);
  }

  stop() {
    this.stopPromise ||= this.shutdown();
    return this.stopPromise;
  }

  async shutdown() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.finishRecovery(false);
    const connection = this.connection;
    if (!connection) return true;
    // Queue shutdown before EOF and give the helper a short chance to mute and
    // leave. Only close confirms exit, including after forced termination.
    const deadline = new AbortController();
    const closed = connection.exited.then(() => true);
    void this.send(connection, 'shutdown', {}).catch(() => {});
    connection.child.stdin.end();
    void delay(this.shutdownGraceMs, undefined, { signal: deadline.signal }).then(() => {
      if (this.connection === connection) terminate(connection.child);
    }).catch(() => {});
    try {
      return await Promise.race([
        closed,
        delay(this.shutdownDeadlineMs, false, { signal: deadline.signal })
      ]);
    } finally {
      deadline.abort();
    }
  }
}

let activeSession = null;

async function startNativeVoice(options) {
  if (process.env.VOICE_ROOM_NATIVE_VOICE !== '1') throw fault('disabled-by-env');
  if (activeSession) throw fault('session-active');
  const helper = findVoiceHelper(options);
  if (!helper) throw fault('helper-unavailable');
  const session = new VoiceSession(helper, { callScoped: options?.callScoped });
  activeSession = session;
  try {
    await session.start();
    return session;
  } catch (error) {
    await stopNativeVoice();
    throw error;
  }
}

function stopNativeVoice() {
  const session = activeSession;
  if (!session) return undefined;
  const release = () => {
    if (activeSession === session) activeSession = null;
  };
  return session.stop().then((closed) => {
    if (closed || !session.connection) release();
    else void session.connection.exited.then(release);
    return closed;
  });
}

function createVoiceQuitHandler(app, stop = stopNativeVoice) {
  let shutdown;
  return (event) => {
    if (!shutdown) {
      const stopping = stop();
      if (!stopping) return false;
      shutdown = Promise.resolve(stopping).then((closed) => {
        shutdown = null;
        if (closed) app.quit();
        else app.exit(0);
      }, () => app.exit(0));
    }
    event.preventDefault();
    return true;
  };
}

module.exports = { findVoiceHelper, startNativeVoice, stopNativeVoice, createVoiceQuitHandler, VoiceSession };
