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

function reserveLab(root) {
  const lab = process.env.VRLAB_LAB
    || path.resolve(root, '..', 'VoiceRoom', '.omc', 'research', 'voice-under-load', 'followup', 'lab');
  const lock = path.join(lab, 'trial.lock');
  const owner = JSON.stringify({ name: 'desktop-receive-smoke', pid: process.pid, nonce: randomUUID() });
  try {
    fs.writeFileSync(lock, owner, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Voice lab is in use (trial.lock).');
    throw error;
  }
  return () => {
    if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock);
  };
}

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
  const examples = path.join(target, 'x86_64-pc-windows-msvc', 'release', 'examples');
  const publisher = path.join(examples, 'smoke_sender.exe');
  const observer = path.join(examples, 'capture_watch.exe');
  assert.ok(fs.existsSync(publisher) && fs.existsSync(observer), 'Build the smoke_sender and capture_watch examples first.');
  const name = `vrlab-desk-${randomUUID()}`;
  let sender;
  let senderExit;
  let containerStarted = false;
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort(new Error('Smoke interrupted'));
  const releaseLab = reserveLab(root);
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

    const monitor = spawn(observer, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
    const monitorExit = once(monitor, 'close');
    const reports = [];
    monitor.stdin.on('error', () => {});
    createInterface({ input: monitor.stdout }).on('line', (line) => reports.push(line));
    const readPeak = async (pid) => {
      const start = reports.length;
      const prefix = `peak ${pid} `;
      monitor.stdin.write(`${pid}\n`);
      const report = await waitFor(
        () => reports.slice(start).find((line) => line.startsWith(prefix)),
        'No WASAPI level from the observer.', 2000
      );
      const peak = Number(report.slice(prefix.length));
      assert.ok(peak >= 0, 'Could not read the helper render session peak.');
      return peak;
    };
    try {
      await Promise.race([
        waitFor(() => {
          interrupted.signal.throwIfAborted();
          return reports.some((line) => /^ready [1-9][0-9]*$/.test(line));
        }, 'Capture observer did not arm.'),
        monitorExit.then(() => { throw new Error('Capture observer exited before it armed.'); })
      ]);
      let pids;
      try {
        pids = await verifyReceive({ url, token: jwt(name, 'listener#voice.smoke', false), sid, interrupted, readPeak });
      } finally {
        const stopped = await stopNativeVoice();
        assert.notEqual(stopped, false, 'The helper exit was not confirmed.');
      }
      // Let the observer consume callbacks already dispatched during teardown.
      await delay(250);
      monitor.stdin.end();
      const deadline = setTimeout(() => monitor.kill(), 2000);
      try { assert.deepEqual(await monitorExit, [0, null]); } finally { clearTimeout(deadline); }
      assert.ok(!reports.includes('error'), 'Unable to attribute a capture session.');
      for (const pid of pids) {
        assert.ok(!reports.includes(`capture ${pid}`), 'The receive helper opened a capture session.');
      }
      console.log('Native voice smoke passed.');
    } finally {
      monitor.kill();
      await monitorExit;
    }
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
        try {
          if (containerStarted) docker(['rm', '-f', name]);
        } finally {
          releaseLab();
        }
      }
    }
  }
}

async function verifyReceive({ url, token, sid, interrupted, readPeak }) {
  const session = await startNativeVoice();
  const child = session.connection.child;
  let stats = null;
  let transport = null;
  let mediaReady = false;
  let probe = true;
  const probeSamples = [];
  session.on('event', ({ kind, payload }) => {
    if (kind === 'stats') {
      stats = payload;
      if (probe) probeSamples.push(stats);
    }
    if (kind === 'transport') transport = payload.state;
    if (kind === 'media-ready') mediaReady = true;
  });
  const waitStats = (predicate, failure) => waitFor(() => {
    interrupted.signal.throwIfAborted();
    return stats && predicate(stats) && stats;
  }, failure);
  const device = await session.request('join', { url, token, tracks: [sid], muted: true });
  assert.equal(device.muted, true);
  assert.equal(device.captureEnabled, false);
  assert.equal(device.captureInitialized, false);
  const first = await waitStats((row) => row.totalSamplesReceived > 0, 'No inbound audio while muted.');
  assert.equal(transport, 'connected');
  assert.equal(mediaReady, true);
  await waitStats((row) => row.totalSamplesReceived > first.totalSamplesReceived, 'Muted receive counters stalled.');
  await assert.rejects(session.request('output-device', { outputDevice: 'missing-device' }),
    { code: 'device-unavailable' });
  if (device.outputs.length) {
    const selected = await session.request('output-device', { outputDevice: device.outputs[0].id });
    assert.equal(selected.outputDevice, device.outputs[0].id);
    assert.equal((await session.request('output-device', { outputDevice: null })).outputDevice, null);
  }
  assert.equal(await readPeak(child.pid), 0);
  probe = false;
  assert.equal((await session.request('update', { muted: false })).muted, false);
  const playback = await waitStats((row) => row.renderSessions > 0, 'No active WASAPI render session.');
  await waitFor(async () => await readPeak(child.pid) > 0.0001, 'No audio signal in the helper render session.');
  assert.equal(playback.captureSessions, 0);
  for (const sample of probeSamples) {
    assert.equal(sample.renderSessions, 0);
    assert.equal(sample.captureSessions, 0);
  }
  const terminal = once(session, 'terminal', { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(1000)]) });
  assert.equal(child.kill(), true);
  assert.deepEqual(await terminal, ['helper-exited']);
  assert.equal(session.connection, null);
  return [child.pid];
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
