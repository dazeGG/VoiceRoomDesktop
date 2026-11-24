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
  switch (kind) {
    case 'join':
      device.muted = payload.muted;
      reply(device);
      break;
    case 'output-mute':
      device.muted = payload.muted;
      if (mode === 'lost-mute-reply') process.exit(1);
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
      if (mode === 'stalled') return;
      reply({});
      process.stdout.end(() => process.exit(0));
      break;
    default:
      reply({});
  }
}));
