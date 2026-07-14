'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  bindingToHelperArgument,
  createNativeHotkeyBackend,
  findNativeHotkeyHelper,
  normalizeReadyMessage
} = require('../electron/native/hotkeys');

function binding(code = 'KeyM', overrides = {}) {
  return {
    altKey: false,
    code,
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    ...overrides
  };
}

function createChild({ exitOnKill = true, exitOnStdinEnd = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.killSignals = [];
  child.stdin = {
    ended: false,
    end() {
      this.ended = true;
      if (exitOnStdinEnd) queueMicrotask(() => child.finish(0, null));
    }
  };
  child.finish = (code = 0, signal = null) => {
    if (child.exitCode !== null || child.signalCode) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.kill = (signal) => {
    child.killed = true;
    child.killSignals.push(signal);
    if (exitOnKill) queueMicrotask(() => child.finish(null, signal));
    return true;
  };
  return child;
}

test('helper arguments preserve DOM physical code and exact modifiers', () => {
  assert.equal(bindingToHelperArgument('mic-mute', binding()), 'mic-mute|KeyM|CS');
  assert.equal(
    bindingToHelperArgument('push-to-talk', binding('Space', {
      ctrlKey: false,
      metaKey: true,
      shiftKey: false
    })),
    'push-to-talk|Space|M'
  );
  assert.equal(bindingToHelperArgument('push-to-talk', binding('Space', {
    ctrlKey: false,
    shiftKey: false
  })), 'push-to-talk|Space|-');
  assert.equal(bindingToHelperArgument('unknown', binding()), null);
  assert.equal(bindingToHelperArgument('mic-mute', binding('Key M')), null);
});

test('ready messages are allowlisted and account for omitted actions', () => {
  assert.deepEqual(normalizeReadyMessage({
    registered: ['mic-mute', 'unknown'],
    failed: [{ action: 'output-mute', reason: 'registration-failed' }]
  }, ['mic-mute', 'output-mute', 'push-to-talk']), {
    registered: ['mic-mute'],
    failed: [
      { action: 'output-mute', reason: 'registration-failed' },
      { action: 'push-to-talk', reason: 'registration-failed' }
    ]
  });
});

test('native backend parses chunked JSON events, filters phases, and suspends delivery', async () => {
  const child = createChild();
  const spawnCalls = [];
  const actions = [];
  const unavailable = [];
  const backend = createNativeHotkeyBackend({
    helperPath: '/native/VoiceRoomHotkeys',
    log: { warn() {} },
    platform: 'darwin',
    spawn: (command, args, options) => {
      spawnCalls.push({ args, command, options });
      return child;
    },
    startupTimeoutMs: 1000
  });
  const ready = backend.start({
    'mic-mute': binding(),
    'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
  }, {
    onAction: (payload) => actions.push(payload),
    onUnavailable: (payload) => unavailable.push(payload)
  });

  child.stdout.write('{"event":"rea');
  child.stdout.write('dy","registered":["mic-mute","push-to-talk"],"failed":[]}\n');
  assert.deepEqual(await ready, {
    available: true,
    failed: [],
    reason: '',
    registered: ['mic-mute', 'push-to-talk']
  });
  assert.deepEqual(spawnCalls[0].args, [
    '--binding', 'mic-mute|KeyM|CS',
    '--binding', 'push-to-talk|Space|-'
  ]);
  assert.deepEqual(spawnCalls[0].options.stdio, ['pipe', 'pipe', 'pipe']);

  child.stdout.write('{"event":"hotkey","action":"push-to-talk","phase":"pressed"}\n');
  child.stdout.write('{"event":"hotkey","action":"unknown","phase":"pressed"}\n');
  child.stdout.write('{"event":"hotkey","action":"mic-mute","phase":"invalid"}\n');
  assert.deepEqual(actions, [{ action: 'push-to-talk', phase: 'pressed' }]);

  backend.setSuspended(true);
  child.stdout.write('{"event":"hotkey","action":"push-to-talk","phase":"released"}\n');
  assert.equal(actions.length, 1);
  backend.setSuspended(false);
  child.stdout.write('{"event":"hotkey","action":"push-to-talk","phase":"released"}\n');
  assert.deepEqual(actions.at(-1), { action: 'push-to-talk', phase: 'released' });

  child.exitCode = 1;
  child.emit('exit', 1, null);
  assert.deepEqual(unavailable, [{
    failed: [
      { action: 'mic-mute', reason: 'helper-exited' },
      { action: 'push-to-talk', reason: 'helper-exited' }
    ],
    registered: []
  }]);
});

test('native backend reports a missing helper and shuts an active helper down through stdin', async () => {
  const missing = createNativeHotkeyBackend({
    appPath: '/definitely/missing',
    platform: 'darwin',
    resourcesPath: '/also/missing'
  });
  assert.deepEqual(await missing.start({ 'mic-mute': binding() }), {
    available: false,
    failed: [{ action: 'mic-mute', reason: 'helper-missing' }],
    reason: 'helper-missing',
    registered: []
  });

  const child = createChild();
  const backend = createNativeHotkeyBackend({
    helperPath: '/native/VoiceRoomHotkeys',
    platform: 'darwin',
    spawn: () => child,
    startupTimeoutMs: 1000
  });
  const first = backend.start({ 'mic-mute': binding() });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write('{"event":"ready","registered":["mic-mute"],"failed":[]}\n');
  await first;

  await backend.stop();
  assert.equal(child.stdin.ended, true);
  assert.deepEqual(child.killSignals, []);
});

test('native backend balances an active push-to-talk press before intentional shutdown', async () => {
  const child = createChild();
  const actions = [];
  const backend = createNativeHotkeyBackend({
    helperPath: '/native/VoiceRoomHotkeys',
    platform: 'win32',
    spawn: () => child,
    startupTimeoutMs: 1000
  });
  const started = backend.start({
    'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
  }, {
    onAction: (payload) => actions.push(payload)
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write('{"event":"ready","registered":["push-to-talk"],"failed":[]}\n');
  await started;
  child.stdout.write('{"event":"hotkey","action":"push-to-talk","phase":"pressed"}\n');

  await backend.stop();
  assert.deepEqual(actions, [
    { action: 'push-to-talk', phase: 'pressed' },
    { action: 'push-to-talk', phase: 'released' }
  ]);
});

test('suspended native release clears PTT state without a duplicate shutdown release', async () => {
  const child = createChild();
  const actions = [];
  const backend = createNativeHotkeyBackend({
    helperPath: '/native/VoiceRoomHotkeys',
    platform: 'win32',
    spawn: () => child,
    startupTimeoutMs: 1000
  });
  const started = backend.start({
    'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
  }, {
    onAction: (payload) => actions.push(payload)
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write('{"event":"ready","registered":["push-to-talk"],"failed":[]}\n');
  await started;
  child.stdout.write('{"event":"hotkey","action":"push-to-talk","phase":"pressed"}\n');
  backend.setSuspended(true);
  child.stdout.write('{"event":"hotkey","action":"push-to-talk","phase":"released"}\n');
  backend.setSuspended(false);

  await backend.stop();
  assert.deepEqual(actions, [{ action: 'push-to-talk', phase: 'pressed' }]);
});

test('replacement waits for the previous helper exit before spawning', async () => {
  const firstChild = createChild({ exitOnStdinEnd: false });
  const secondChild = createChild();
  const children = [firstChild, secondChild];
  const spawnCalls = [];
  const backend = createNativeHotkeyBackend({
    helperPath: '/native/VoiceRoomHotkeys',
    platform: 'darwin',
    spawn: (...args) => {
      spawnCalls.push(args);
      return children[spawnCalls.length - 1];
    },
    startupTimeoutMs: 1000
  });

  const first = backend.start({ 'mic-mute': binding() });
  await new Promise((resolve) => setImmediate(resolve));
  firstChild.stdout.write('{"event":"ready","registered":["mic-mute"],"failed":[]}\n');
  await first;

  const replacement = backend.start({ 'mic-mute': binding('KeyD') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstChild.stdin.ended, true);
  assert.equal(spawnCalls.length, 1);

  firstChild.finish(0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCalls.length, 2);
  secondChild.stdout.write('{"event":"ready","registered":["mic-mute"],"failed":[]}\n');
  assert.deepEqual(await replacement, {
    available: true,
    failed: [],
    reason: '',
    registered: ['mic-mute']
  });
});

test('replacement fails closed until a late helper exit is confirmed', async () => {
  const firstChild = createChild({ exitOnKill: false, exitOnStdinEnd: false });
  const secondChild = createChild();
  const children = [firstChild, secondChild];
  const spawnCalls = [];
  const backend = createNativeHotkeyBackend({
    helperPath: '/native/VoiceRoomHotkeys',
    platform: 'darwin',
    shutdownConfirmMs: 5,
    shutdownForceMs: 5,
    shutdownGraceMs: 5,
    unrefShutdownTimers: false,
    spawn: (...args) => {
      spawnCalls.push(args);
      return children[spawnCalls.length - 1];
    },
    startupTimeoutMs: 1000
  });

  const first = backend.start({ 'mic-mute': binding() });
  await new Promise((resolve) => setImmediate(resolve));
  firstChild.stdout.write('{"event":"ready","registered":["mic-mute"],"failed":[]}\n');
  await first;

  const replacement = await backend.start({ 'mic-mute': binding('KeyD') });
  assert.deepEqual(replacement, {
    available: false,
    failed: [{ action: 'mic-mute', reason: 'helper-shutdown-timeout' }],
    reason: 'helper-shutdown-timeout',
    registered: []
  });
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(firstChild.killSignals, ['SIGTERM', 'SIGKILL']);
  firstChild.finish(0, null);

  const recovered = backend.start({ 'mic-mute': binding('KeyD') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCalls.length, 2);
  secondChild.stdout.write('{"event":"ready","registered":["mic-mute"],"failed":[]}\n');
  assert.deepEqual(await recovered, {
    available: true,
    failed: [],
    reason: '',
    registered: ['mic-mute']
  });
});

test('helper lookup rejects unsupported platforms without probing paths', () => {
  assert.deepEqual(findNativeHotkeyHelper({ platform: 'linux' }), {
    candidates: [],
    path: '',
    reason: 'platform-unsupported'
  });
});

test('platform helpers preserve release events, layout-independent keys, and forwarded input', () => {
  const root = path.join(__dirname, '..');
  const mac = fs.readFileSync(
    path.join(root, 'native', 'hotkeys', 'macos', 'VoiceRoomHotkeys.swift'),
    'utf8'
  );
  const windows = fs.readFileSync(
    path.join(root, 'native', 'hotkeys', 'windows', 'VoiceRoomHotkeys.cpp'),
    'utf8'
  );
  const build = fs.readFileSync(path.join(root, 'scripts', 'build-native-hotkeys.js'), 'utf8');

  assert.match(mac, /CGEvent\.tapCreate/);
  assert.match(mac, /options: \.listenOnly/);
  assert.match(mac, /CGPreflightListenEventAccess/);
  assert.match(mac, /tapDisabledByTimeout/);
  assert.match(mac, /downKeyCodes\.insert/);
  assert.match(mac, /kVK_ANSI_M/);
  assert.match(mac, /Darwin\.read\(STDIN_FILENO/);
  assert.match(windows, /WH_KEYBOARD_LL/);
  assert.match(windows, /KBDLLHOOKSTRUCT/);
  assert.match(windows, /LLKHF_EXTENDED/);
  assert.match(windows, /CallNextHookEx/);
  assert.match(windows, /ParentPipeWatcher/);
  assert.match(windows, /MsgWaitForMultipleObjectsEx/);
  assert.match(windows, /PeekNamedPipe/);
  assert.match(windows, /kParentWatcherJoinMs/);
  assert.doesNotMatch(windows, /WaitForSingleObject\(parentPipeThread, INFINITE\)/);
  assert.match(windows, /InitializeDownKeyState/);
  assert.match(windows, /ForegroundKeyboardLayout/);
  assert.match(windows, /MapVirtualKeyExW/);
  assert.match(windows, /HasSharedVirtualKeyState/);
  assert.match(windows, /IsSharedKeyGroupDown/);
  assert.match(windows, /kClearSharedKeyMessage/);
  assert.match(windows, /ForgetDownKey/);
  assert.match(windows, /binding\.active = false/);
  assert.match(build, /VoiceRoomHotkeys\.swift/);
  assert.match(build, /VoiceRoomHotkeys\.cpp/);
  assert.match(build, /requireUniversal/);
  assert.match(build, /-verify_arch/);
  assert.match(build, /minimumMacOSTarget = '12\.0'/);
  assert.match(build, /'-target', hostTarget/);
});
