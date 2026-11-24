'use strict';

const { createDecoder, encode, VERSION } = require('../../electron/native/voice-frames');

const [epoch, , mode] = process.argv.slice(2);
const device = {
  outputDevice: null,
  effectiveOutputDevice: 'test-output',
  muted: false,
  captureEnabled: false,
  captureInitialized: false,
  outputs: [{ id: 'test-output', name: 'Test output' }]
};
let trackCount = 0;
let joined = false;
const send = (kind, payload, id = 0) => {
  process.stdout.write(encode({ v: VERSION, epoch, kind, id, payload }));
};

send('hello', {
  helperVersion: '0.1.0',
  capabilities: { receive: true, capture: false, publish: false, outputSelection: true }
});
send('ready', { captureInitialized: false });
if (mode === 'stalled') setInterval(() => {}, 1000);

process.stdin.on('data', createDecoder(({ id, kind, payload }) => {
  const reply = (data) => send('response', { command: kind, data }, id);
  const publishState = () => {
    send('device', device);
    send('stats', {
      jitterBufferDelay: 0.125,
      jitterBufferEmittedCount: 48 * trackCount,
      concealedSamples: 4,
      silentConcealedSamples: 2,
      concealmentEvents: 1,
      totalSamplesReceived: 50 * trackCount,
      packetsLost: -1,
      rtt: null,
      captureSessions: 0,
      renderSessions: device.muted ? 0 : 1
    });
  };
  switch (kind) {
    case 'list-outputs':
      reply({ outputs: [{ ...device.outputs[0], isDefault: true }] });
      break;
    case 'join': {
      if (mode === 'lost-join-reply') process.exit(1);
      if (mode === 'slow-join') {
        send('transport', { state: 'reconnecting' });
        break;
      }
      joined = true;
      device.muted = payload.muted;
      device.outputDevice = payload.outputDevice ?? null;
      trackCount = payload.tracks?.length ?? 0;
      reply(device);
      if (['bridge', 'hung-control', 'failed-unmute', 'lost-playout'].includes(mode)) {
        send('transport', { state: 'connected' });
        send('media-ready', { captureInitialized: false });
        publishState();
      }
      if (mode === 'hung-control') {
        // Keep a live media path independently of the unread control pipe.
        process.stdin.pause();
        setInterval(() => {}, 1000);
      }
      if (mode === 'lost-playout') {
        setTimeout(() => {
          device.muted = true;
          send('device', device);
          send('fault', { code: 'output-not-rendering' });
        }, 100);
      }
      break;
    }
    case 'update':
      if (mode === 'failed-unmute' && payload.muted === false) {
        send('device', device);
        send('error', { command: kind, code: 'output-not-rendering' }, id);
        setInterval(() => {}, 1000);
        return;
      }
      if (Object.hasOwn(payload, 'muted')) device.muted = payload.muted;
      if (Object.hasOwn(payload, 'outputDevice')) device.outputDevice = payload.outputDevice;
      if (Object.hasOwn(payload, 'tracks')) trackCount = payload.tracks.length;
      if (mode === 'lost-update-reply') process.exit(1);
      reply(device);
      publishState();
      break;
    case 'output-mute':
      device.muted = payload.muted;
      reply(device);
      break;
    case 'output-device':
      if (mode === 'normal') {
        reply(device);
        break;
      }
      device.muted = true;
      send('error', { command: kind, code: 'device-switch-failed' }, id);
      send('device', device);
      process.stdout.end(() => process.exit(1));
      break;
    case 'shutdown':
      if (mode === 'stalled' || (joined && mode === 'failed-unmute')) return;
      reply({});
      process.stdout.end(() => process.exit(0));
      break;
    default:
      reply({});
  }
}));
