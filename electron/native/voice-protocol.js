'use strict';

const version = /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;
const errors = {
  join: ['bad-payload', 'already-joined', 'device-unavailable', 'device-switch-failed', 'join-timeout', 'join-failed'],
  leave: ['bad-payload', 'leave-timeout', 'leave-failed'],
  shutdown: ['bad-payload', 'leave-timeout', 'leave-failed'],
  subscriptions: ['bad-payload', 'not-joined'],
  'output-mute': ['bad-payload', 'not-joined'],
  'output-device': ['bad-payload', 'not-joined', 'device-unavailable', 'device-switch-failed'],
  ping: ['bad-payload']
};

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const count = (value) => Number.isInteger(value) && value >= 0;
const nullable = (value, valid) => value === null || valid(value);
const text = (value) => typeof value === 'string';

function isHello(payload) {
  return exact(payload, ['helperVersion', 'capabilities'])
    && text(payload.helperVersion) && version.test(payload.helperVersion)
    && exact(payload.capabilities, ['receive', 'capture', 'publish', 'outputSelection'])
    && payload.capabilities.receive === true && payload.capabilities.capture === false
    && payload.capabilities.publish === false && payload.capabilities.outputSelection === true;
}

function isReady(payload) {
  return exact(payload, ['captureInitialized']) && payload.captureInitialized === false;
}

function isDevice(payload) {
  return exact(payload, ['outputDevice', 'effectiveOutputDevice', 'muted', 'captureEnabled', 'captureInitialized', 'outputs'])
    && nullable(payload.outputDevice, text) && text(payload.effectiveOutputDevice)
    && typeof payload.muted === 'boolean' && payload.captureEnabled === false && payload.captureInitialized === false
    && Array.isArray(payload.outputs)
    && payload.outputs.every((device) => exact(device, ['id', 'name']) && text(device.id) && text(device.name));
}

function isStats(payload) {
  return exact(payload, ['jitterBufferDelay', 'jitterBufferEmittedCount', 'concealedSamples',
    'concealmentEvents', 'packetsLost', 'rtt', 'captureSessions', 'renderSessions'])
    && nonnegative(payload.jitterBufferDelay) && count(payload.jitterBufferEmittedCount)
    && count(payload.concealedSamples) && count(payload.concealmentEvents)
    && Number.isInteger(payload.packetsLost) && nullable(payload.rtt, nonnegative)
    && nullable(payload.captureSessions, (value) => value === 0) && nullable(payload.renderSessions, count);
}

function isEvent(kind, payload) {
  switch (kind) {
    case 'transport':
      return exact(payload, ['state']) && ['connected', 'reconnecting', 'disconnected'].includes(payload.state);
    case 'device': return isDevice(payload);
    case 'media-ready': return isReady(payload);
    case 'stats': return isStats(payload);
    default: return false;
  }
}

function isReply(kind, payload) {
  return exact(payload, ['command', 'data'])
    && (['join', 'output-mute', 'output-device'].includes(kind) ? isDevice(payload.data) : exact(payload.data, []));
}

function isError(kind, payload) {
  return exact(payload, ['command', 'code']) && errors[kind].includes(payload.code);
}

module.exports = { exact, isHello, isReady, isEvent, isReply, isError };
