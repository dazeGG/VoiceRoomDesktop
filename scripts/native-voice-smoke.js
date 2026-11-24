'use strict';

const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHmac, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { startNativeVoice, stopNativeVoice } = require('../electron/native/voice');

const ports = { signal: 17980, tcp: 17981, udp: 17982 };
const base = `http://127.0.0.1:${ports.signal}`;
const url = base.replace('http:', 'ws:');

function jwt(room, identity, publish) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'devkey', sub: identity, nbf: now - 10, exp: now + 120,
    video: { room, roomJoin: true, canPublish: publish, canSubscribe: !publish, canPublishData: false }
  };
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${body}.${createHmac('sha256', 'secret').update(body).digest('base64url')}`;
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 90000 });
}

async function waitFor(check, failure, timeout = 12000) {
  const deadline = performance.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error(failure);
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.VOICE_ROOM_NATIVE_VOICE, '1');
  const root = path.resolve(__dirname, '..');
  const target = path.resolve(root, 'native', 'voice', process.env.CARGO_TARGET_DIR || 'target');
  const publisher = path.join(target, 'x86_64-pc-windows-msvc', 'release', 'examples', 'smoke_sender.exe');
  assert.ok(fs.existsSync(publisher), 'Build the smoke_sender Cargo example first.');
  const name = `vrlab-desk-${randomUUID()}`;
  let sender;
  let senderExit;
  let containerStarted = false;
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort(new Error('Smoke interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const config = `port: ${ports.signal}\nrtc:\n  tcp_port: ${ports.tcp}\n  udp_port: ${ports.udp}\n  use_external_ip: false\n`;
    docker([
      'run', '-d', '--rm', '--name', name,
      '-p', `127.0.0.1:${ports.signal}:${ports.signal}/tcp`,
      '-p', `127.0.0.1:${ports.tcp}:${ports.tcp}/tcp`,
      '-p', `127.0.0.1:${ports.udp}:${ports.udp}/udp`,
      'livekit/livekit-server:v1.13.11', '--dev', '--config-body', config, '--bind', '0.0.0.0',
      '--node-ip', '127.0.0.1'
    ]);
    containerStarted = true;
    await waitFor(async () => {
      interrupted.signal.throwIfAborted();
      return fetch(base, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    }, 'LiveKit did not start.');

    sender = spawn(publisher, [url], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    sender.stdin.on('error', () => {});
    senderExit = once(sender, 'close');
    const lines = createInterface({ input: sender.stdout });
    const started = once(lines, 'line', { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15000)]) });
    sender.stdin.write(`${jwt(name, 'publisher', true)}\n`);
    const [sid] = await Promise.race([
      started,
      senderExit.then(() => { throw new Error('Publisher exited before publication.'); })
    ]);
    assert.ok(sid.startsWith('TR_'));

    const session = await startNativeVoice();
    let stats = null;
    let transport = null;
    let mediaReady = false;
    session.on('event', ({ kind, payload }) => {
      if (kind === 'stats') stats = payload;
      if (kind === 'transport') transport = payload.state;
      if (kind === 'media-ready') mediaReady = true;
    });
    const waitStats = (predicate, failure) => waitFor(() => {
      interrupted.signal.throwIfAborted();
      return stats && predicate(stats) && stats;
    }, failure);
    const device = await session.request('join', { url, token: jwt(name, 'listener#voice', false) });
    assert.equal(device.captureEnabled, false);
    assert.equal(device.captureInitialized, false);
    await waitStats(() => true, 'No stats while in room.');
    assert.equal(transport, 'connected');
    assert.equal(mediaReady, true);
    assert.equal(stats.jitterBufferEmittedCount, 0, 'Unexpected subscription');
    assert.equal(stats.captureSessions, 0);

    await session.request('subscriptions', { tracks: [sid] });
    await waitStats((row) => row.jitterBufferEmittedCount > 0, 'No inbound audio while muted.');
    assert.equal(stats.renderSessions, 0);
    assert.equal(stats.captureSessions, 0);
    await assert.rejects(session.request('output-device', { outputDevice: 'missing-device' }),
      { code: 'device-unavailable' });
    if (device.outputs.length) {
      const selected = await session.request('output-device', { outputDevice: device.outputs[0].id });
      assert.equal(selected.outputDevice, device.outputs[0].id);
      assert.equal((await session.request('output-device', { outputDevice: null })).outputDevice, null);
    }
    await session.request('output-mute', { muted: false });
    const playback = await waitStats((row) => row.renderSessions > 0, 'No active WASAPI render session.');
    assert.equal(playback.captureSessions, 0);
    console.log(JSON.stringify(playback));
    await session.request('leave');
    console.log('Native voice smoke passed.');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try {
      await stopNativeVoice();
    } finally {
      try {
        if (sender) {
          sender.stdin.end();
          const deadline = setTimeout(() => sender.kill(), 1500);
          try { await senderExit; } finally { clearTimeout(deadline); }
        }
      } finally {
        if (containerStarted) docker(['rm', '-f', name]);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
