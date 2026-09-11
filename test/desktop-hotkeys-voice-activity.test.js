'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createDesktopHotkeyController } = require('../electron/hotkeys');

function createSender() {
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = () => {};
  return sender;
}

function createController() {
  return createDesktopHotkeyController({
    globalShortcut: {
      register: () => true,
      setSuspended() {},
      unregister() {}
    },
    isTrustedFrame: () => true,
    log: { warn() {} },
    nativeHotkeys: null
  });
}

test('voice activity listeners follow renderer connection reports without duplicates', async () => {
  const controller = createController();
  const sender = createSender();
  const event = { sender, senderFrame: { url: 'https://voice.example' } };
  const changes = [];
  controller.onVoiceActiveChange((active) => changes.push(active));

  await controller.configure(event, { active: true, bindings: {} });
  await controller.configure(event, { active: true, bindings: {} });
  assert.equal(controller.isVoiceActive(), true);

  await controller.configure(event, { active: false });
  assert.equal(controller.isVoiceActive(), false);

  await controller.configure(event, { active: true, bindings: {} });
  sender.emit('render-process-gone');

  assert.deepEqual(changes, [true, false, true, false]);
});

test('a throwing voice activity listener does not break hotkey configuration', async () => {
  const controller = createController();
  const changes = [];
  controller.onVoiceActiveChange(() => {
    throw new Error('listener failed');
  });
  const unsubscribe = controller.onVoiceActiveChange((active) => changes.push(active));

  const result = await controller.configure(
    { sender: createSender(), senderFrame: { url: 'https://voice.example' } },
    { active: true, bindings: {} }
  );
  unsubscribe();
  controller.deactivate();

  assert.equal(result.active, true);
  assert.deepEqual(changes, [true]);
});
