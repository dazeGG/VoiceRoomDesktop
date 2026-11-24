'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { createNativeVoiceIpc, createVoiceQuitHandler } = require('../electron/native/voice-ipc');
const { VoiceSession } = require('../electron/native/voice');
const { VERSION } = require('../electron/native/voice-frames');
const { isTrustedFrame } = require('../electron/security/origin');

const origin = 'https://voiceroom.ru';
const prefix = 'desktop-native-voice:';
const fixture = path.join(__dirname, 'fixtures', 'native-voice-child.js');
const admission = {
  callId: 'call-a',
  url: 'wss://livekit.voiceroom.ru/?vr_gate_credential=synthetic',
  token: 'synthetic.jwt.signature',
  tracks: ['TR_mic'],
  outputDeviceId: null,
  muted: false
};
const outputs = [{ id: 'test-output', name: 'Test output', isDefault: true }];

function setup(t, { mode = 'bridge', outputProbeIdleMs } = {}) {
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  const window = new EventEmitter();
  const webContents = new EventEmitter();
  window.webContents = webContents;
  webContents.isDestroyed = () => false;
  const events = new EventEmitter();
  const delivered = [];
  const frame = {
    origin,
    url: `${origin}/room`,
    send(channel, payload) {
      assert.equal(channel, `${prefix}event`);
      delivered.push(payload);
      events.emit(payload.kind, payload);
    }
  };
  webContents.mainFrame = frame;
  const sender = { sender: webContents, senderFrame: frame };
  const sessions = [];
  const children = [];
  let active;
  const ipc = createNativeVoiceIpc({
    ipcMain, trustedOrigin: origin, isTrustedFrame: (candidate) => isTrustedFrame(candidate, origin),
    mediaOrigins: 'wss://livekit.voiceroom.ru,wss://voice.example:8443',
    outputProbeIdleMs,
    async startNativeVoice({ callScoped } = {}) {
      assert.equal(active, undefined, 'the old process must close first');
      const session = new VoiceSession(fixture, {
        callScoped,
        restartDelayMs: 30,
        restartCooldownMs: 0,
        spawnChild(_helper, args, options) {
          const child = spawn(process.execPath, [fixture, ...args, children.length ? 'bridge' : mode], options);
          children.push(child);
          return child;
        }
      });
      sessions.push(session);
      active = session;
      await session.start();
      return session;
    },
    stopNativeVoice() {
      if (!active) return undefined;
      const stopping = active;
      return stopping.stop().then((closed) => {
        if (active === stopping && closed) active = undefined;
        return closed;
      });
    }
  });
  ipc.configure();
  ipc.attachWindow(window);
  t.after(() => ipc.stopForQuit());
  return {
    window, webContents, frame, sender, delivered, events, sessions, children,
    invoke: (method, ...args) => handlers.get(prefix + method)(sender, ...args),
    invokeFrom: (other, method, ...args) => handlers.get(prefix + method)(other, ...args),
    canExpose(other) {
      const event = { ...other };
      ipcMain.emit(`${prefix}expose`, event);
      return event.returnValue;
    },
    quit: (app) => createVoiceQuitHandler(app, ipc.stopForQuit)
  };
}

test('native voice is scoped to the trusted primary top-level frame and validates requests', { timeout: 5000 }, async (t) => {
  const app = setup(t);
  assert.equal(app.canExpose(app.sender), true);
  const siblingFrame = { url: origin };
  const otherWindow = { mainFrame: siblingFrame };
  for (const sender of [
    { sender: otherWindow, senderFrame: siblingFrame },
    { sender: app.webContents, senderFrame: siblingFrame },
    { sender: app.webContents, senderFrame: null }
  ]) {
    assert.equal(app.canExpose(sender), false);
    assert.throws(() => app.invokeFrom(sender, 'get-capability'), { code: 'untrusted-frame' });
  }
  app.frame.url = 'https://voiceroom.ru.evil.test/';
  assert.equal(app.canExpose(app.sender), false);
  app.frame.url = origin;
  app.frame.origin = 'null';
  assert.equal(app.canExpose(app.sender), false);
  app.frame.origin = origin;
  assert.deepEqual(app.invoke('get-capability'), { available: true, protocol: VERSION });
  assert.equal(app.sessions.length, 0);
  assert.throws(() => app.invoke('list-outputs', {}), { message: 'bad-payload' });
  for (const changes of [
    { url: 'ws://livekit.voiceroom.ru/' },
    { url: 'wss://voiceroom.ru.evil.test/' },
    { url: 'wss://user:pass@livekit.voiceroom.ru/' },
    { url: 'wss://livekit.voiceroom.ru/#private' },
    { url: 'wss://livekit.voiceroom.ru:8443/' },
    { token: 'synthetic\ncredential' },
    { tracks: ['TR_mic', 'TR_mic'] },
    { tracks: ['invalid track'] },
    { tracks: new Array(1) },
    { outputDeviceId: {} },
    { muted: 0 },
    { capture: true },
    { callId: '' }
  ]) {
    assert.deepEqual(app.invoke('start', { ...admission, ...changes }), { ok: false, code: 'bad-payload' });
  }
  assert.deepEqual(app.invoke('start', admission, 'extra'), { ok: false, code: 'bad-payload' });
  assert.deepEqual(app.invoke('update', { callId: admission.callId, token: admission.token }), {
    ok: false, code: 'bad-payload'
  });
  await assert.rejects(app.invoke('stop', { callId: admission.callId, extra: true }), { message: 'bad-payload' });
  assert.equal(app.sessions.length, 0);
  assert.equal(app.children.length, 0);
  assert.deepEqual(await app.invoke('start', { ...admission, url: 'wss://voice.example:8443/rtc?region=eu' }), { ok: true });
  assert.deepEqual(await app.invoke('list-outputs'), outputs);
  assert.equal(app.children.length, 1, 'the active helper handles endpoint enumeration');
});

test('listing outputs lazily starts a helper in a no-join state and the call reuses it', { timeout: 5000 }, async (t) => {
  const app = setup(t);
  assert.deepEqual(app.invoke('get-capability'), { available: true, protocol: VERSION });
  assert.equal(app.children.length, 0);
  assert.throws(() => app.invokeFrom({ ...app.sender, senderFrame: null }, 'list-outputs'), { code: 'untrusted-frame' });
  assert.deepEqual(await app.invoke('list-outputs'), outputs);
  assert.equal(app.children.length, 1);
  assert.equal(app.sessions[0].capabilities.capture, false);
  await assert.rejects(app.sessions[0].request('output-mute', { muted: true }), { code: 'not-joined' });
  assert.deepEqual(app.delivered, []);
  assert.deepEqual(await app.invoke('start', { ...admission, outputDeviceId: outputs[0].id }), { ok: true });
  assert.equal(app.children.length, 1);
  assert.deepEqual(await app.invoke('list-outputs'), outputs);
  await app.invoke('stop', { callId: admission.callId });
  assert.equal(app.children[0].exitCode, 0);
});

test('an idle output probe exits and a later call starts a fresh helper', { timeout: 5000 }, async (t) => {
  const app = setup(t, { outputProbeIdleMs: 25 });
  assert.deepEqual(await app.invoke('list-outputs'), outputs);
  assert.deepEqual(await once(app.children[0], 'close'), [0, null]);
  assert.deepEqual(await app.invoke('start', admission), { ok: true });
  assert.equal(app.children.length, 2);
});

test('navigation closes an output probe before the next document starts a call', { timeout: 5000 }, async (t) => {
  const app = setup(t);
  assert.deepEqual(await app.invoke('list-outputs'), outputs);
  const closed = once(app.children[0], 'close');
  app.webContents.emit('did-navigate');
  assert.deepEqual(await app.invoke('start', admission), { ok: true });
  assert.deepEqual(await closed, [0, null]);
  assert.equal(app.children.length, 2);
});

test('native voice validates gain maps and forwards gains and fallback state', { timeout: 5000 }, async (t) => {
  const app = setup(t, { mode: 'gains' });
  for (const fields of [
    { volumes: null }, { volumes: [] }, { volumes: new Map() },
    { volumes: { microphone: 1 } }, { volumes: { TR_: 1 } },
    { volumes: { TR_mic: -0.1 } }, { volumes: { TR_mic: 2.01 } },
    { volumes: { TR_mic: '1' } }, { volumes: { TR_mic: NaN } },
    { volumes: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['TR_' + i, 1])) },
    { masterVolume: null }, { masterVolume: '1' }, { masterVolume: Infinity }, { masterVolume: 2.01 }
  ]) {
    assert.deepEqual(app.invoke('start', { ...admission, ...fields }), { ok: false, code: 'bad-payload' });
    assert.deepEqual(app.invoke('update', { callId: admission.callId, ...fields }),
      { ok: false, code: 'bad-payload' });
  }
  assert.deepEqual(await app.invoke('start', {
    ...admission, volumes: { TR_mic: 1.5 }, masterVolume: 2
  }), { ok: true });
  const device = once(app.events, 'device');
  assert.deepEqual(await app.invoke('update', {
    callId: admission.callId, volumes: {}, masterVolume: 0, outputDeviceId: 'disconnected'
  }), { ok: true });
  assert.deepEqual((await device)[0], {
    callId: admission.callId, kind: 'device', outputDeviceId: 'disconnected',
    effectiveOutputDeviceId: 'test-output', defaultOutputDeviceId: 'test-output',
    fallback: 'selected-output-unavailable', muted: false
  });
});

for (const muted of [false, true]) {
  test(`native voice faults promptly on child exit with muted=${muted} and permits a new call`,
    { timeout: 8000 }, async (t) => {
      const app = setup(t);
      const ready = once(app.events, 'media-ready');
      const initialStats = once(app.events, 'stats');
      assert.deepEqual(await app.invoke('start', admission), { ok: true });
      assert.deepEqual((await ready)[0], { callId: 'call-a', kind: 'media-ready' });
      const { at, ...sample } = (await initialStats)[0];
      assert.ok(Math.abs(Date.now() - at) < 5000);
      assert.deepEqual(sample, {
        callId: 'call-a', kind: 'stats', jitterBufferDelaySeconds: 0.125, jitterBufferEmittedCount: 48,
        concealedSamples: 4, silentConcealedSamples: 2, concealmentEvents: 1, totalSamplesReceived: 50,
        packetsLost: -1, rttSeconds: null
      });
      const device = once(app.events, 'device');
      const updatedStats = once(app.events, 'stats');
      assert.deepEqual(await app.invoke('update', {
        callId: 'call-a', tracks: ['TR_mic', 'TR_second'], muted, outputDeviceId: 'test-output'
      }), { ok: true });
      assert.deepEqual((await device)[0], {
        callId: 'call-a', kind: 'device', outputDeviceId: 'test-output', effectiveOutputDeviceId: 'test-output',
        defaultOutputDeviceId: 'test-output', fallback: null, muted
      });
      await updatedStats;

      const beforeKill = app.delivered.length;
      const stopped = once(app.events, 'stopped');
      const fault = once(app.events, 'fault', { signal: AbortSignal.timeout(1000) });
      assert.equal(app.children[0].kill(), true);
      assert.deepEqual((await fault)[0], { callId: 'call-a', kind: 'fault', code: 'helper-exited' });
      assert.deepEqual((await stopped)[0], { callId: 'call-a', kind: 'stopped' });
      assert.deepEqual(app.delivered.slice(beforeKill).map(({ kind }) => kind), ['fault', 'stopped']);
      assert.equal(app.children.length, 1);
      assert.deepEqual(app.invoke('update', { callId: 'call-a', muted: true }), { ok: false, code: 'stale-call' });
      assert.ok(!JSON.stringify(app.delivered).includes(admission.token));

      const newReady = once(app.events, 'media-ready');
      assert.deepEqual(await app.invoke('start', { ...admission, callId: 'call-b' }), { ok: true });
      assert.deepEqual((await newReady)[0], { callId: 'call-b', kind: 'media-ready' });
      assert.equal(app.children.length, 2);
    });
}

test('native voice faults when a child exits before acknowledging deafen', { timeout: 5000 }, async (t) => {
  const app = setup(t, { mode: 'lost-update-reply' });
  assert.deepEqual(await app.invoke('start', admission), { ok: true });
  const fault = once(app.events, 'fault');
  assert.deepEqual(await app.invoke('update', { callId: 'call-a', muted: true, outputDeviceId: null }), {
    ok: false, code: 'helper-exited'
  });
  assert.deepEqual((await fault)[0], { callId: 'call-a', kind: 'fault', code: 'helper-exited' });
  assert.equal(app.children.length, 1);
});

test('a hung control pipe is killed before duplicate stops allow browser fallback', { timeout: 5000 }, async (t) => {
  const app = setup(t, { mode: 'hung-control' });
  const device = once(app.events, 'device');
  assert.deepEqual(await app.invoke('start', admission), { ok: true });
  const child = app.children[0];
  assert.equal((await device)[0].muted, false);
  const stopped = once(app.events, 'stopped').then(() => assert.equal(child.signalCode, 'SIGTERM'));
  const before = performance.now();
  const stop = () => app.invoke('stop', { callId: admission.callId }).then(() => {
    assert.equal(child.signalCode, 'SIGTERM');
    assert.ok(performance.now() - before < 1000, 'the renderer restores voice after one second');
  });
  await Promise.all([stop(), stop(), stopped]);
  assert.equal(app.delivered.filter((event) => event.kind === 'stopped').length, 1);
});

for (const mode of ['failed-unmute', 'lost-playout']) {
  test(`native voice reports ${mode} and stops before signalling browser fallback`, { timeout: 5000 }, async (t) => {
    const app = setup(t, { mode });
    const muted = mode === 'failed-unmute';
    assert.deepEqual(await app.invoke('start', { ...admission, muted }), { ok: true });
    const child = app.children[0];
    const fault = once(app.events, 'fault').then(([event]) => {
      assert.equal(child.signalCode, 'SIGTERM');
      return event;
    });
    const stopped = once(app.events, 'stopped');
    if (muted) {
      assert.deepEqual(await app.invoke('update', { callId: admission.callId, muted: false }), {
        ok: false, code: 'output-not-rendering'
      });
    }
    assert.deepEqual(await fault, { callId: admission.callId, kind: 'fault', code: 'output-not-rendering' });
    await stopped;
    assert.deepEqual(app.delivered.slice(-3).map((event) => [event.kind, event.muted]), [
      ['device', true], ['fault', undefined], ['stopped', undefined]
    ]);
    assert.equal(app.children.length, 1);
  });
}

test('native voice faults if the child exits during its first join', { timeout: 5000 }, async (t) => {
  const app = setup(t, { mode: 'lost-join-reply' });
  const fault = once(app.events, 'fault');
  assert.deepEqual(await app.invoke('start', { ...admission, muted: true }), { ok: false, code: 'helper-exited' });
  assert.deepEqual((await fault)[0], { callId: 'call-a', kind: 'fault', code: 'helper-exited' });
  assert.equal(app.children.length, 1);
});

test('replacing a native call shuts down its helper and fences updates and stops by call ID', { timeout: 5000 }, async (t) => {
  const app = setup(t);
  assert.deepEqual(await app.invoke('start', admission), { ok: true });
  const replaced = once(app.events, 'stopped');
  assert.deepEqual(await app.invoke('start', { ...admission, callId: 'call-b' }), { ok: true });
  assert.deepEqual((await replaced)[0], { callId: 'call-a', kind: 'stopped' });
  assert.equal(app.children[0].exitCode, 0);
  assert.deepEqual(app.invoke('update', { callId: 'call-a', muted: true }), { ok: false, code: 'stale-call' });
  assert.equal(await app.invoke('stop', { callId: 'call-a' }), undefined);
  assert.equal(app.children[1].exitCode, null);
  const stopped = once(app.events, 'stopped');
  assert.equal(await app.invoke('stop', { callId: 'call-b' }), undefined);
  assert.deepEqual((await stopped)[0], { callId: 'call-b', kind: 'stopped' });
  assert.equal(app.children[1].exitCode, 0);
});

test('document replacement cancels a pending join and its queued mutation', { timeout: 5000 }, async (t) => {
  const app = setup(t, { mode: 'slow-join' });
  const joining = once(app.events, 'transport');
  const started = app.invoke('start', admission);
  await joining;
  const oldChildClosed = once(app.children[0], 'close');
  const updated = app.invoke('update', { callId: admission.callId, muted: true });
  app.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(await oldChildClosed, [0, null]);
  assert.equal((await started).ok, false);
  assert.deepEqual(await updated, { ok: false, code: 'session-stopped' });

  const oldSender = { ...app.sender };
  const newFrame = { ...app.frame };
  app.webContents.mainFrame = newFrame;
  app.sender.senderFrame = newFrame;
  app.webContents.emit('did-navigate');
  assert.throws(() => app.invokeFrom(oldSender, 'start', admission), { code: 'untrusted-frame' });
  assert.deepEqual(await app.invoke('start', { ...admission, callId: 'call-new' }), { ok: true });
  assert.deepEqual(app.delivered.filter((event) => event.callId === admission.callId), [
    { callId: admission.callId, kind: 'transport', state: 'reconnecting' }
  ]);
});

for (const trigger of ['reload', 'navigation', 'renderer exit', 'window close', 'quit']) {
  test(`native voice stops and fences the old document on ${trigger}`, { timeout: 5000 }, async (t) => {
    const app = setup(t);
    assert.deepEqual(await app.invoke('start', admission), { ok: true });
    const closed = once(app.children[0], 'close');
    switch (trigger) {
      case 'reload':
      case 'navigation':
        app.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
        app.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
        assert.equal(app.children[0].exitCode, null);
        app.webContents.emit('did-start-navigation', {
          isMainFrame: true, isSameDocument: false,
          url: trigger === 'reload' ? app.frame.url : `${origin}/other`
        });
        break;
      case 'renderer exit':
        app.webContents.emit('render-process-gone');
        break;
      case 'window close':
        app.window.emit('closed');
        break;
      case 'quit': {
        let quit = false;
        const handler = app.quit({ quit() { quit = true; } });
        assert.equal(handler({ preventDefault() {} }), true);
        await closed;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(quit, true);
        break;
      }
    }
    assert.throws(() => app.invoke('start', admission), { code: 'untrusted-frame' });
    assert.deepEqual(await closed, [0, null]);
    assert.equal(app.children.length, 1);
  });
}
