'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  ACTION_CHANNEL,
  CONFIGURE_CHANNEL,
  STATUS_CHANNEL,
  SUSPEND_CHANNEL,
  bindingIdentity,
  bindingToAccelerator,
  createDesktopHotkeyController,
  domCodeToAcceleratorKey
} = require('../electron/hotkeys');

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

function createGlobalShortcutMock({ fail = [] } = {}) {
  const callbacks = new Map();
  const unregistered = [];
  const suspended = [];
  let isSuspended = false;
  return {
    callbacks,
    suspended,
    unregistered,
    register(accelerator, callback) {
      if (isSuspended || fail.includes(accelerator) || callbacks.has(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    },
    setSuspended(value) {
      isSuspended = value;
      suspended.push(value);
    },
    unregister(accelerator) {
      unregistered.push(accelerator);
      callbacks.delete(accelerator);
    }
  };
}

function createNativeHotkeysMock(options = {}) {
  let handlers = null;
  let running = false;
  const starts = [];
  const stopped = [];
  const suspended = [];
  return {
    starts,
    stopped,
    suspended,
    emitAction(action, phase) {
      handlers?.onAction?.({ action, phase });
    },
    emitUnavailable(reason = 'helper-exited') {
      handlers?.onUnavailable?.({
        failed: (options.registered || []).map((action) => ({ action, reason })),
        registered: []
      });
    },
    setSuspended(value) {
      suspended.push(value);
    },
    async start(bindings, nextHandlers) {
      starts.push(bindings);
      handlers = nextHandlers;
      if (options.available === false) {
        running = false;
        return {
          available: false,
          failed: Object.keys(bindings).map((action) => ({ action, reason: options.reason || 'helper-missing' })),
          reason: options.reason || 'helper-missing',
          registered: []
        };
      }
      const registered = options.registered || Object.keys(bindings);
      running = registered.length > 0;
      if (options.actionBeforeReady) {
        nextHandlers.onAction?.(options.actionBeforeReady);
      }
      return {
        available: true,
        failed: options.failed || [],
        reason: '',
        registered
      };
    },
    stop() {
      if (running) stopped.push(true);
      running = false;
      handlers = null;
    }
  };
}

function createSender() {
  const sender = new EventEmitter();
  sender.destroyed = false;
  sender.messages = [];
  sender.isDestroyed = () => sender.destroyed;
  sender.send = (...args) => sender.messages.push(args);
  return sender;
}

function createController(options = {}) {
  const globalShortcut = options.globalShortcut || createGlobalShortcutMock();
  const controller = createDesktopHotkeyController({
    globalShortcut,
    isTrustedFrame: () => options.trusted !== false,
    log: { warn() {} },
    nativeHotkeys: options.nativeHotkeys || null
  });
  return { controller, globalShortcut };
}

test('DOM physical key codes become supported Electron fallback accelerators', () => {
  assert.equal(domCodeToAcceleratorKey('KeyM'), 'M');
  assert.equal(domCodeToAcceleratorKey('Digit7'), '7');
  assert.equal(domCodeToAcceleratorKey('F13'), 'F13');
  assert.equal(domCodeToAcceleratorKey('Numpad4'), 'num4');
  assert.equal(domCodeToAcceleratorKey('AudioVolumeUp'), null);

  assert.deepEqual(bindingToAccelerator(binding()), {
    accelerator: 'Control+Shift+M',
    reason: null
  });
  assert.deepEqual(bindingToAccelerator(binding('KeyM', { ctrlKey: false, metaKey: true })), {
    accelerator: 'Super+Shift+M',
    reason: null
  });
  assert.equal(bindingToAccelerator(binding('KeyM', { ctrlKey: false, shiftKey: false })).reason, 'modifier-required');
  assert.equal(bindingToAccelerator(binding('F13', { ctrlKey: false, shiftKey: false })).accelerator, 'F13');
  assert.equal(bindingIdentity(binding()), 'KeyM|C|-|S|-');
});

test('native controller registers every assigned action and forwards press/release phases', async () => {
  const nativeHotkeys = createNativeHotkeysMock();
  const { controller, globalShortcut } = createController({ nativeHotkeys });
  const sender = createSender();
  const result = await controller.configure(
    { sender, senderFrame: { url: 'https://voice.example' } },
    {
      active: true,
      configurationId: 42,
      bindings: {
        'mic-mute': binding(),
        'output-mute': binding('KeyD'),
        'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
      }
    }
  );

  assert.equal(result.backend, 'native');
  assert.equal(result.configurationId, 42);
  assert.deepEqual(result.registered, ['push-to-talk', 'mic-mute', 'output-mute']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual([...globalShortcut.callbacks.keys()], []);

  nativeHotkeys.emitAction('push-to-talk', 'pressed');
  nativeHotkeys.emitAction('push-to-talk', 'released');
  nativeHotkeys.emitAction('mic-mute', 'pressed');
  assert.deepEqual(sender.messages, [
    [ACTION_CHANNEL, { action: 'push-to-talk', configurationId: 42, phase: 'pressed' }],
    [ACTION_CHANNEL, { action: 'push-to-talk', configurationId: 42, phase: 'released' }],
    [ACTION_CHANNEL, { action: 'mic-mute', configurationId: 42, phase: 'pressed' }]
  ]);

  const inactive = await controller.configure(
    { sender, senderFrame: { url: 'https://voice.example' } },
    { active: false, bindings: { 'mic-mute': binding() } }
  );
  assert.equal(inactive.active, false);
  assert.deepEqual(inactive.registered, []);
});

test('native actions emitted with the ready chunk are delivered before configure resolves', async () => {
  const nativeHotkeys = createNativeHotkeysMock({
    actionBeforeReady: { action: 'mic-mute', phase: 'pressed' }
  });
  const { controller } = createController({ nativeHotkeys });
  const sender = createSender();

  const result = await controller.configure(
    { sender, senderFrame: { url: 'https://voice.example' } },
    {
      active: true,
      bindings: { 'mic-mute': binding() }
    }
  );

  assert.deepEqual(result.registered, ['mic-mute']);
  assert.deepEqual(sender.messages, [
    [ACTION_CHANNEL, { action: 'mic-mute', configurationId: 1, phase: 'pressed' }]
  ]);
});

test('partial native failures fall back to Electron for toggle actions', async () => {
  const nativeHotkeys = createNativeHotkeysMock({
    failed: [
      { action: 'mic-mute', reason: 'input-monitoring-required' },
      { action: 'output-mute', reason: 'registration-failed' }
    ],
    registered: ['push-to-talk']
  });
  const { controller, globalShortcut } = createController({ nativeHotkeys });
  const sender = createSender();
  const result = await controller.configure(
    { sender, senderFrame: { url: 'https://voice.example' } },
    {
      active: true,
      bindings: {
        'mic-mute': binding(),
        'output-mute': binding('KeyD'),
        'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
      }
    }
  );

  assert.equal(result.backend, 'native');
  assert.deepEqual(result.registered, ['push-to-talk', 'mic-mute', 'output-mute']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual([...globalShortcut.callbacks.keys()], [
    'Control+Shift+M',
    'Control+Shift+D'
  ]);
});

test('Electron fallback keeps toggle actions global and reports unavailable push-to-talk', async () => {
  const nativeHotkeys = createNativeHotkeysMock({ available: false });
  const { controller, globalShortcut } = createController({ nativeHotkeys });
  const sender = createSender();
  const result = await controller.configure(
    { sender, senderFrame: {} },
    {
      active: true,
      bindings: {
        'mic-mute': binding(),
        'output-mute': binding('KeyD'),
        'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
      }
    }
  );

  assert.equal(result.backend, 'electron-fallback');
  assert.deepEqual(result.registered, ['mic-mute', 'output-mute']);
  assert.deepEqual(result.unsupported, ['push-to-talk']);
  assert.deepEqual(result.failed, [{ action: 'push-to-talk', reason: 'helper-missing' }]);
  globalShortcut.callbacks.get('Control+Shift+M')();
  assert.deepEqual(sender.messages, [[ACTION_CHANNEL, {
    action: 'mic-mute',
    configurationId: 1,
    phase: 'pressed'
  }]]);
  assert.equal(controller.setSuspended({ sender, senderFrame: {} }, true), true);
  assert.equal(controller.setSuspended({ sender, senderFrame: {} }, false), false);
  assert.deepEqual(globalShortcut.suspended, [true, false]);
});

test('controller reports duplicate chords, invalid fallback bindings, and OS failures', async () => {
  const globalShortcut = createGlobalShortcutMock({ fail: ['Control+Shift+M'] });
  const { controller } = createController({ globalShortcut });
  const sender = createSender();
  const failed = await controller.configure(
    { sender, senderFrame: {} },
    {
      active: true,
      bindings: {
        'mic-mute': binding(),
        'output-mute': binding('KeyP', { ctrlKey: false, shiftKey: false })
      }
    }
  );
  assert.deepEqual(failed.failed, [
    { action: 'mic-mute', reason: 'registration-failed' },
    { action: 'output-mute', reason: 'modifier-required' }
  ]);

  const nativeHotkeys = createNativeHotkeysMock();
  const nativeController = createController({ nativeHotkeys }).controller;
  const duplicate = await nativeController.configure(
    { sender, senderFrame: {} },
    {
      active: true,
      bindings: {
        'mic-mute': binding('KeyD'),
        'output-mute': binding('KeyO'),
        'push-to-talk': binding('KeyD')
      }
    }
  );
  assert.deepEqual(duplicate.registered, ['push-to-talk', 'output-mute']);
  assert.deepEqual(duplicate.failed, [{ action: 'mic-mute', reason: 'duplicate-binding' }]);
});

test('controller rejects untrusted frames and cleans up only after completed document navigation', async () => {
  const untrusted = createController({ trusted: false }).controller;
  await assert.rejects(
    untrusted.configure({ sender: createSender(), senderFrame: {} }, { active: true }),
    /configured Voice Room URL/
  );

  const { controller, globalShortcut } = createController();
  const sender = createSender();
  await controller.configure(
    { sender, senderFrame: {} },
    { active: true, bindings: { 'mic-mute': binding() } }
  );
  sender.emit('did-start-navigation', {}, 'https://voice.example/#next', true, true);
  assert.deepEqual([...globalShortcut.callbacks.keys()], ['Control+Shift+M']);
  sender.emit('did-start-navigation', {}, 'https://external.example', false, true);
  assert.deepEqual([...globalShortcut.callbacks.keys()], ['Control+Shift+M']);
  sender.emit('did-navigate', {}, 'https://voice.example/next');
  assert.deepEqual([...globalShortcut.callbacks.keys()], []);

  const nextSender = createSender();
  await controller.configure(
    { sender: nextSender, senderFrame: {} },
    { active: true, bindings: { 'mic-mute': binding() } }
  );
  nextSender.emit('render-process-gone');
  assert.deepEqual([...globalShortcut.callbacks.keys()], []);

  const destroyedSender = createSender();
  await controller.configure(
    { sender: destroyedSender, senderFrame: {} },
    { active: true, bindings: { 'mic-mute': binding() } }
  );
  destroyedSender.destroyed = true;
  destroyedSender.emit('destroyed');
  assert.deepEqual([...globalShortcut.callbacks.keys()], []);
});

test('renderer send races fail closed without throwing from a global callback', async () => {
  const { controller, globalShortcut } = createController();
  const sender = createSender();
  sender.send = () => {
    throw new Error('renderer gone');
  };
  await controller.configure(
    { sender, senderFrame: {} },
    { active: true, bindings: { 'mic-mute': binding() } }
  );

  assert.doesNotThrow(() => globalShortcut.callbacks.get('Control+Shift+M')());
  assert.deepEqual([...globalShortcut.callbacks.keys()], []);
});

test('native helper exit releases push-to-talk, restores toggles, and publishes status', async () => {
  const nativeHotkeys = createNativeHotkeysMock({
    registered: ['push-to-talk', 'mic-mute', 'output-mute']
  });
  const { controller, globalShortcut } = createController({ nativeHotkeys });
  const sender = createSender();
  await controller.configure(
    { sender, senderFrame: {} },
    {
      active: true,
      bindings: {
        'mic-mute': binding(),
        'output-mute': binding('KeyD'),
        'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
      }
    }
  );
  nativeHotkeys.emitAction('push-to-talk', 'pressed');
  nativeHotkeys.emitUnavailable();

  assert.deepEqual([...globalShortcut.callbacks.keys()], ['Control+Shift+M', 'Control+Shift+D']);
  assert.deepEqual(sender.messages[0], [ACTION_CHANNEL, {
    action: 'push-to-talk',
    configurationId: 1,
    phase: 'pressed'
  }]);
  assert.deepEqual(sender.messages[1], [ACTION_CHANNEL, {
    action: 'push-to-talk',
    configurationId: 1,
    phase: 'released'
  }]);
  assert.equal(sender.messages[2][0], STATUS_CHANNEL);
  assert.deepEqual(sender.messages[2][1].registered, ['mic-mute', 'output-mute']);
  assert.deepEqual(sender.messages[2][1].failed, [{ action: 'push-to-talk', reason: 'helper-exited' }]);
});

test('IPC installation is idempotent and suspension belongs to the active renderer', async () => {
  const nativeHotkeys = createNativeHotkeysMock();
  const { controller, globalShortcut } = createController({ nativeHotkeys });
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel)
  };
  controller.install(ipcMain);
  controller.install(ipcMain);
  assert.deepEqual([...handlers.keys()], [CONFIGURE_CHANNEL, SUSPEND_CHANNEL]);

  const sender = createSender();
  await handlers.get(CONFIGURE_CHANNEL)(
    { sender, senderFrame: {} },
    {
      active: true,
      bindings: {
        'mic-mute': binding(),
        'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
      }
    }
  );
  nativeHotkeys.emitAction('push-to-talk', 'pressed');
  assert.equal(handlers.get(SUSPEND_CHANNEL)({ sender, senderFrame: {} }, true), true);
  assert.deepEqual(nativeHotkeys.suspended, [false, true]);
  assert.deepEqual(globalShortcut.suspended, []);
  assert.deepEqual(sender.messages.at(-1), [ACTION_CHANNEL, {
    action: 'push-to-talk',
    configurationId: 1,
    phase: 'released'
  }]);
  assert.equal(handlers.get(SUSPEND_CHANNEL)({ sender: createSender(), senderFrame: {} }, false), false);

  controller.dispose();
  assert.deepEqual(globalShortcut.suspended, []);
  assert.deepEqual([...handlers.keys()], []);
});

test('lock and suspend release PTT once, reset the helper, and resume after every reason clears', async () => {
  const nativeHotkeys = createNativeHotkeysMock();
  const { controller } = createController({ nativeHotkeys });
  const powerMonitor = new EventEmitter();
  const sender = createSender();
  controller.installPowerMonitor(powerMonitor);
  await controller.configure(
    { sender, senderFrame: {} },
    {
      active: true,
      bindings: {
        'mic-mute': binding(),
        'push-to-talk': binding('Space', { ctrlKey: false, shiftKey: false })
      }
    }
  );

  nativeHotkeys.emitAction('push-to-talk', 'pressed');
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('suspend');
  assert.deepEqual(sender.messages.slice(0, 2), [
    [ACTION_CHANNEL, { action: 'push-to-talk', configurationId: 1, phase: 'pressed' }],
    [ACTION_CHANNEL, { action: 'push-to-talk', configurationId: 1, phase: 'released' }]
  ]);
  assert.equal(nativeHotkeys.stopped.length, 1);

  powerMonitor.emit('unlock-screen');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeHotkeys.starts.length, 1);

  powerMonitor.emit('resume');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeHotkeys.starts.length, 2);
  assert.deepEqual(sender.messages.at(-1), [STATUS_CHANNEL, {
    active: true,
    backend: 'native',
    configurationId: 1,
    failed: [],
    registered: ['push-to-talk', 'mic-mute'],
    unsupported: []
  }]);

  nativeHotkeys.emitAction('push-to-talk', 'pressed');
  assert.deepEqual(sender.messages.at(-1), [
    ACTION_CHANNEL,
    { action: 'push-to-talk', configurationId: 1, phase: 'pressed' }
  ]);

  controller.dispose();
  assert.equal(powerMonitor.listenerCount('lock-screen'), 0);
  assert.equal(powerMonitor.listenerCount('suspend'), 0);
});

test('renderer recording suspension remains active across screen lock recovery', async () => {
  const nativeHotkeys = createNativeHotkeysMock();
  const { controller } = createController({ nativeHotkeys });
  const powerMonitor = new EventEmitter();
  const sender = createSender();
  controller.installPowerMonitor(powerMonitor);
  await controller.configure(
    { sender, senderFrame: {} },
    {
      active: true,
      bindings: { 'mic-mute': binding() }
    }
  );

  assert.equal(controller.setSuspended({ sender, senderFrame: {} }, true), true);
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('unlock-screen');
  await new Promise((resolve) => setImmediate(resolve));

  nativeHotkeys.emitAction('mic-mute', 'pressed');
  assert.equal(sender.messages.filter(([channel]) => channel === ACTION_CHANNEL).length, 0);
  assert.equal(controller.setSuspended({ sender, senderFrame: {} }, false), false);
  nativeHotkeys.emitAction('mic-mute', 'pressed');
  assert.deepEqual(sender.messages.at(-1), [
    ACTION_CHANNEL,
    { action: 'mic-mute', configurationId: 1, phase: 'pressed' }
  ]);
});

test('Electron fallback re-registers while renderer suspension spans screen lock', async () => {
  const nativeHotkeys = createNativeHotkeysMock({ available: false });
  const { controller, globalShortcut } = createController({ nativeHotkeys });
  const powerMonitor = new EventEmitter();
  const sender = createSender();
  controller.installPowerMonitor(powerMonitor);
  await controller.configure(
    { sender, senderFrame: {} },
    { active: true, bindings: { 'mic-mute': binding() } }
  );

  controller.setSuspended({ sender, senderFrame: {} }, true);
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('unlock-screen');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual([...globalShortcut.callbacks.keys()], ['Control+Shift+M']);
  assert.equal(controller.setSuspended({ sender, senderFrame: {} }, false), false);
  globalShortcut.callbacks.get('Control+Shift+M')();
  assert.deepEqual(sender.messages.at(-1), [
    ACTION_CHANNEL,
    { action: 'mic-mute', configurationId: 1, phase: 'pressed' }
  ]);
});
