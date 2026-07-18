'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  failPendingReconfigures,
  handleChildStdinError,
  handleRendererMessage,
  postToRenderer
} = require('../electron/native/capture-relay');

it('pauses the helper at the renderer backlog limit and resumes after an ACK', () => {
  const childCommands = [];
  const rendererMessages = [];
  const session = {
    child: {
      stdin: {
        writable: true,
        write(command) { childCommands.push(command); }
      }
    },
    framesDroppedBackpressure: 0,
    framesInFlight: 0,
    framesPosted: 0,
    helperPaused: false,
    port: {
      postMessage(message) { rendererMessages.push(message); }
    },
    stopped: false
  };
  const frame = { data: new ArrayBuffer(16), height: 2, type: 'frame', width: 2 };

  assert.equal(postToRenderer(session, frame), true);
  assert.equal(postToRenderer(session, frame), true);
  assert.equal(session.framesInFlight, 2);
  assert.equal(session.helperPaused, true);
  assert.deepEqual(childCommands, ['{"cmd":"set-paused","paused":true}\n']);

  assert.equal(postToRenderer(session, frame), true);
  assert.equal(rendererMessages.length, 2);
  assert.equal(session.framesDroppedBackpressure, 1);
  assert.deepEqual(childCommands, ['{"cmd":"set-paused","paused":true}\n']);

  handleRendererMessage(session, { data: { type: 'frame-ack' } });
  assert.equal(session.framesInFlight, 1);
  assert.equal(session.helperPaused, false);
  assert.deepEqual(childCommands, [
    '{"cmd":"set-paused","paused":true}\n',
    '{"cmd":"set-paused","paused":false}\n'
  ]);
});

it('ignores a late stdin error from a replaced helper', () => {
  const oldChild = {};
  const replacementChild = {};
  const timer = setTimeout(() => {}, 60000);
  timer.unref?.();
  const session = {
    child: replacementChild,
    pendingReconfigures: new Map([[7, { timer }]]),
    stopped: false
  };

  assert.equal(handleChildStdinError(session, oldChild), false);
  assert.equal(session.pendingReconfigures.has(7), true);
  assert.equal(handleChildStdinError(session, replacementChild), true);
  assert.equal(session.pendingReconfigures.size, 0);
});

it('turns every pending helper request into an explicit session failure', () => {
  const timer = setTimeout(() => {}, 60000);
  timer.unref?.();
  const session = {
    pendingReconfigures: new Map([[11, { timer }]])
  };

  assert.deepEqual(failPendingReconfigures(session, 'session-stopped'), [{
    ok: false,
    reason: 'session-stopped',
    requestId: 11,
    type: 'reconfigured'
  }]);
  assert.equal(session.pendingReconfigures.size, 0);
});
