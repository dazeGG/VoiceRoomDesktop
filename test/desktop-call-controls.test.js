'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
  ACTION_CHANNEL,
  INACTIVE_CALL_STATE,
  STATE_CHANNEL,
  createCallControlsController,
  describeCallControls,
  describeCallTooltip,
  sanitizeCallState
} = require('../electron/call-controls');

class FakeSender extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.sent = [];
  }

  isDestroyed() { return this.destroyed; }
  send(channel, payload) { this.sent.push([channel, payload]); }
}

const ACTIVE = { active: true, micMuted: false, outputMuted: false, roomId: 'abc123', roomName: 'Гостиная' };

describe('call state sanitizing', () => {
  it('collapses anything that is not an explicit active call to the inactive state', () => {
    for (const payload of [undefined, null, 'x', {}, { active: 'true' }, { active: false, micMuted: true, roomName: 'X' }]) {
      assert.equal(sanitizeCallState(payload), INACTIVE_CALL_STATE);
    }
  });

  it('keeps booleans strict, strips control characters and bounds the room name', () => {
    assert.deepEqual({ ...sanitizeCallState({
      active: true,
      micMuted: 1,
      outputMuted: true,
      roomId: 'bad id!',
      roomName: `  Комната${String.fromCharCode(0, 10, 127)}${'я'.repeat(100)}  `
    }) }, {
      active: true,
      micMuted: false,
      outputMuted: true,
      roomId: '',
      roomName: `Комната${'я'.repeat(73)}`
    });
  });
});

describe('call control descriptions', () => {
  it('lists no controls outside a call', () => {
    assert.deepEqual(describeCallControls(INACTIVE_CALL_STATE), []);
    assert.equal(describeCallTooltip(INACTIVE_CALL_STATE), 'Voice Room');
  });

  it('labels actions and shows state icons', () => {
    assert.deepEqual(describeCallControls(ACTIVE), [
      { action: 'toggle-mic', icon: 'mic', label: 'Выключить микрофон' },
      { action: 'toggle-output', icon: 'headphones', label: 'Выключить звук' },
      { action: 'disconnect', icon: 'phone-off', label: 'Отключиться' }
    ]);
    assert.deepEqual(
      describeCallControls({ ...ACTIVE, micMuted: true, outputMuted: true }).map(({ icon, label }) => [icon, label]),
      [['mic-off', 'Включить микрофон'], ['headphone-off', 'Включить звук'], ['phone-off', 'Отключиться']]
    );
    assert.equal(describeCallTooltip(ACTIVE), 'Voice Room — Гостиная');
    assert.equal(describeCallTooltip({ ...ACTIVE, roomName: '' }), 'Voice Room — в звонке');
  });
});

describe('call controls controller', () => {
  it('notifies listeners only on real changes', () => {
    const controller = createCallControlsController();
    const sender = new FakeSender();
    const seen = [];
    controller.onStateChange((state) => seen.push(state.active ? state.micMuted : 'inactive'));

    controller.setState(sender, ACTIVE);
    controller.setState(sender, { ...ACTIVE });
    controller.setState(sender, { ...ACTIVE, micMuted: true });
    controller.setState(sender, { active: false });

    assert.deepEqual(seen, [false, true, 'inactive']);
  });

  it('dispatches known actions to the renderer that owns the call', () => {
    const controller = createCallControlsController();
    const sender = new FakeSender();

    assert.equal(controller.dispatch('toggle-mic'), false, 'no call yet');
    controller.setState(sender, ACTIVE);
    assert.equal(controller.dispatch('toggle-mic'), true);
    assert.equal(controller.dispatch('disconnect'), true);
    assert.equal(controller.dispatch('explode'), false);
    assert.deepEqual(sender.sent, [
      [ACTION_CHANNEL, { action: 'toggle-mic' }],
      [ACTION_CHANNEL, { action: 'disconnect' }]
    ]);

    sender.destroyed = true;
    assert.equal(controller.dispatch('toggle-mic'), false);
  });

  it('ends the call when the owner navigates, crashes or is destroyed', () => {
    for (const eventName of ['did-navigate', 'render-process-gone', 'destroyed']) {
      const controller = createCallControlsController();
      const sender = new FakeSender();
      const seen = [];
      controller.onStateChange((state) => seen.push(state.active));

      controller.setState(sender, ACTIVE);
      sender.emit(eventName);

      assert.equal(controller.getState().active, false, eventName);
      assert.deepEqual(seen, [true, false], eventName);
      assert.equal(sender.listenerCount('did-navigate'), 0, eventName);
      assert.equal(controller.dispatch('toggle-mic'), false, eventName);
    }
  });

  it('ignores an inactive report from a renderer that does not own the call', () => {
    const controller = createCallControlsController();
    const owner = new FakeSender();
    controller.setState(owner, ACTIVE);

    controller.setState(new FakeSender(), { active: false });
    assert.equal(controller.getState().active, true);
  });

  it('keeps a listener failure from breaking the others', () => {
    const controller = createCallControlsController({ log: { warn() {} } });
    const seen = [];
    controller.onStateChange(() => { throw new Error('boom'); });
    controller.onStateChange((state) => seen.push(state.active));
    controller.setState(new FakeSender(), ACTIVE);
    assert.deepEqual(seen, [true]);
  });

  it('accepts state only from trusted frames over IPC', () => {
    const controller = createCallControlsController();
    const handlers = new Map();
    controller.configureIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      isTrustedFrame: (frame) => frame?.trusted === true
    });
    const sender = new FakeSender();

    assert.throws(
      () => handlers.get(STATE_CHANNEL)({ sender, senderFrame: { trusted: false } }, ACTIVE),
      /Desktop call controls are only available for the configured Voice Room URL\./
    );
    assert.equal(controller.getState().active, false);
    assert.deepEqual(handlers.get(STATE_CHANNEL)({ sender, senderFrame: { trusted: true } }, ACTIVE), ACTIVE);
  });
});
