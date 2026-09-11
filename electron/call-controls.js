'use strict';

const STATE_CHANNEL = 'desktop-call:set-state';
const ACTION_CHANNEL = 'desktop-call:action';
const CALL_ACTIONS = Object.freeze(['toggle-mic', 'toggle-output', 'disconnect']);
const MAX_ROOM_NAME_LENGTH = 80;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const INACTIVE_CALL_STATE = Object.freeze({
  active: false,
  micMuted: false,
  outputMuted: false,
  roomId: '',
  roomName: ''
});

function stripControlCharacters(value) {
  return Array.from(value).filter((char) => {
    const code = char.codePointAt(0);
    return code > 31 && code !== 127;
  }).join('');
}

function sanitizeCallState(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (source.active !== true) return INACTIVE_CALL_STATE;

  const roomName = typeof source.roomName === 'string'
    ? stripControlCharacters(source.roomName).trim().slice(0, MAX_ROOM_NAME_LENGTH)
    : '';
  return Object.freeze({
    active: true,
    micMuted: source.micMuted === true,
    outputMuted: source.outputMuted === true,
    roomId: typeof source.roomId === 'string' && ROOM_ID_PATTERN.test(source.roomId) ? source.roomId : '',
    roomName
  });
}

function sameCallState(a, b) {
  return a.active === b.active
    && a.micMuted === b.micMuted
    && a.outputMuted === b.outputMuted
    && a.roomId === b.roomId
    && a.roomName === b.roomName;
}

// Labels name the action a click performs; icons show the current state.
function describeCallControls(state) {
  if (!state?.active) return [];
  return [
    {
      action: 'toggle-mic',
      icon: state.micMuted ? 'mic-off' : 'mic',
      label: state.micMuted ? 'Включить микрофон' : 'Выключить микрофон'
    },
    {
      action: 'toggle-output',
      icon: state.outputMuted ? 'headphone-off' : 'headphones',
      label: state.outputMuted ? 'Включить звук' : 'Выключить звук'
    },
    {
      action: 'disconnect',
      icon: 'phone-off',
      label: 'Отключиться'
    }
  ];
}

function describeCallTooltip(state) {
  if (!state?.active) return 'Voice Room';
  return state.roomName ? `Voice Room — ${state.roomName}` : 'Voice Room — в звонке';
}

function createCallControlsController({ log = console } = {}) {
  const listeners = new Set();
  let state = INACTIVE_CALL_STATE;
  let owner = null;
  let ownerListeners = [];

  function notify() {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        log.warn?.('Call state listener failed:', error);
      }
    }
  }

  function setCurrentState(next) {
    if (sameCallState(state, next)) return;
    state = next;
    notify();
  }

  function detachOwner() {
    if (owner) {
      for (const [eventName, listener] of ownerListeners) owner.removeListener?.(eventName, listener);
    }
    owner = null;
    ownerListeners = [];
  }

  function reset() {
    detachOwner();
    setCurrentState(INACTIVE_CALL_STATE);
  }

  function attachOwner(sender) {
    if (owner === sender) return;
    detachOwner();
    owner = sender;
    // Same-document route changes keep the call; a real document navigation,
    // a crashed renderer or a closed window end it.
    ownerListeners = [
      ['destroyed', reset],
      ['render-process-gone', reset],
      ['did-navigate', reset]
    ];
    owner.once?.('destroyed', reset);
    owner.once?.('render-process-gone', reset);
    owner.on?.('did-navigate', reset);
  }

  function setState(sender, payload) {
    const next = sanitizeCallState(payload);
    if (next.active) attachOwner(sender);
    else if (!owner || owner === sender) detachOwner();
    else return state;
    setCurrentState(next);
    return state;
  }

  function dispatch(action) {
    if (!CALL_ACTIONS.includes(action) || !state.active || !owner || owner.isDestroyed?.()) return false;
    owner.send(ACTION_CHANNEL, { action });
    return true;
  }

  function onStateChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function configureIpc({ ipcMain, isTrustedFrame }) {
    ipcMain.handle(STATE_CHANNEL, (event, payload) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('Desktop call controls are only available for the configured Voice Room URL.');
      }
      return { ...setState(event.sender, payload) };
    });
  }

  return {
    configureIpc,
    dispatch,
    getState: () => state,
    onStateChange,
    reset,
    setState
  };
}

module.exports = {
  ACTION_CHANNEL,
  CALL_ACTIONS,
  INACTIVE_CALL_STATE,
  STATE_CHANNEL,
  createCallControlsController,
  describeCallControls,
  describeCallTooltip,
  sanitizeCallState
};
