'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const test = require('node:test');
const { createDecoder, encode, MAX_FRAME, VERSION } = require('../electron/native/voice-frames');
const { findVoiceHelper, startNativeVoice, createVoiceQuitHandler, VoiceSession } = require('../electron/native/voice');

const helper = findVoiceHelper();
const windowsOnly = { skip: !helper && 'Windows x64 native helper is not built', timeout: 12000 };
const epoch = 'test-epoch';
const fixture = path.join(__dirname, 'fixtures', 'native-voice-child.js');

if (process.env.VOICE_ROOM_REQUIRE_NATIVE_VOICE === '1') {
  assert.ok(helper, 'The Windows CI lifecycle step requires the built helper');
}

function spawnFixture(args, options, mode) {
  return spawn(process.execPath, [fixture, ...args, mode], options);
}

function filterFrames(child, filter) {
  const stdout = child.stdout;
  const filtered = new PassThrough();
  stdout.on('data', createDecoder((frame) => {
    const replacement = filter(frame);
    if (replacement) filtered.write(Buffer.isBuffer(replacement) ? replacement : encode(replacement));
  }));
  stdout.on('end', () => filtered.end());
  child.stdout = filtered;
  return child;
}

function connect(t, parentPid = process.pid, env = process.env) {
  const child = spawn(helper, [epoch, String(parentPid)], { windowsHide: true, env });
  t.after(() => child.kill());
  const frames = [];
  const waiting = [];
  child.stdout.on('data', createDecoder((frame) => {
    const resolve = waiting.shift();
    if (resolve) resolve(frame);
    else frames.push(frame);
  }));
  return {
    child,
    exit: once(child, 'close'),
    next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve) => waiting.push(resolve)),
    send: (id, kind, extra = {}) => child.stdin.write(encode({ v: VERSION, epoch, id, kind, payload: {}, ...extra }))
  };
}

async function handshake(link) {
  const hello = await link.next();
  assert.deepEqual(hello.v, VERSION);
  assert.equal(hello.epoch, epoch);
  assert.equal(hello.id, 0);
  assert.equal(hello.kind, 'hello');
  assert.equal(hello.payload.capabilities.receive, true);
  assert.equal(hello.payload.capabilities.capture, false);
  assert.equal(hello.payload.capabilities.publish, false);
  const ready = await link.next();
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.payload.captureInitialized, false);
}

test('required Windows lifecycle suite fails when helper lookup misses', () => {
  const supervisor = require.resolve('../electron/native/voice');
  const result = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(supervisor)}).findVoiceHelper = () => null;
    require(${JSON.stringify(__filename)});
    process.exit(0);
  `], {
    env: { ...process.env, VOICE_ROOM_REQUIRE_NATIVE_VOICE: '1' },
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Windows CI lifecycle step requires the built helper/);
});

test('native voice entry point is disabled by default', async () => {
  const previous = process.env.VOICE_ROOM_NATIVE_VOICE;
  delete process.env.VOICE_ROOM_NATIVE_VOICE;
  try {
    await assert.rejects(startNativeVoice(), { code: 'disabled-by-env' });
  } finally {
    if (previous !== undefined) process.env.VOICE_ROOM_NATIVE_VOICE = previous;
  }
});

test('voice framing decodes arbitrary chunk boundaries and rejects invalid bytes', () => {
  const received = [];
  const frame = { label: '音' };
  const decode = createDecoder((value) => received.push(value));
  for (const byte of Buffer.concat([encode(frame), encode(frame)])) decode(Buffer.from([byte]));
  assert.deepEqual(received, [frame, frame]);
  assert.throws(() => decode(Buffer.from([1, 0, 0, 0, 255])));
});

test('native voice handshake, version and epoch rejection, stable errors and EOF', windowsOnly, async (t) => {
  const link = connect(t);
  await handshake(link);
  link.send(7, 'ping', { v: { major: 0, minor: 0 } });
  link.send(3, 'ping', { epoch: 'previous-epoch' });
  link.send(9, 'secret-must-not-echo', { payload: { token: 'other-secret-must-not-echo' } });
  link.send(4, 'ping');
  const replies = await Promise.all(Array.from({ length: 4 }, () => link.next()));
  assert.deepEqual(replies.map(({ id, kind, payload }) => [id, kind, payload.code]), [
    [7, 'error', 'version-mismatch'], [3, 'error', 'stale-epoch'],
    [9, 'error', 'unknown-command'], [4, 'response', undefined]
  ]);
  assert.ok(!JSON.stringify(replies).includes('secret-must-not-echo'));
  link.child.stdin.end();
  assert.deepEqual(await link.exit, [0, null]);
});

test('native voice rejects malformed and oversized frames safely', windowsOnly, async (t) => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME + 1);
  for (const [bytes, code] of [[header, 'frame-size'], [Buffer.from([1, 0, 0, 0, 255]), 'bad-frame']]) {
    const link = connect(t);
    await handshake(link);
    link.child.stdin.write(bytes);
    const reply = await link.next();
    assert.deepEqual([reply.kind, reply.payload.code], ['fault', code]);
    assert.deepEqual(await link.exit, [0, null]);
  }
});

test('native voice supervisor correlates concurrent requests and acknowledges shutdown', windowsOnly, async (t) => {
  const session = new VoiceSession(helper);
  t.after(() => session.stop());
  assert.equal((await session.start()).capture, false);
  const replies = await Promise.allSettled([
    session.request('ping'),
    session.request('output-mute', { muted: true }),
    session.request('leave')
  ]);
  assert.equal(replies[0].status, 'fulfilled');
  assert.equal(replies[1].reason.code, 'not-joined');
  assert.equal(replies[2].status, 'fulfilled');
  const { child } = session.connection;
  await session.stop();
  assert.equal(child.exitCode, 0);
});

test('native voice enumerates render endpoints before joining and rejects invalid updates', windowsOnly, async (t) => {
  const session = new VoiceSession(helper);
  t.after(() => session.stop());
  assert.equal((await session.start()).capture, false);
  const { outputs } = await session.request('list-outputs');
  assert.ok(outputs.every((output) => output.id && output.name && typeof output.isDefault === 'boolean'));
  assert.ok(outputs.filter((output) => output.isDefault).length <= 1);
  assert.equal(new Set(outputs.map((output) => output.id)).size, outputs.length);
  await assert.rejects(session.request('list-outputs', { open: true }), { code: 'bad-payload' });
  await assert.rejects(session.request('update', { outputDevice: null }), { code: 'not-joined' });
});

test('heartbeat loss replaces a real helper only once', windowsOnly, async (t) => {
  const pids = [];
  const session = new VoiceSession(helper, {
    heartbeatMs: 30, heartbeatTimeoutMs: 100, restartDelayMs: 20, restartCooldownMs: 0,
    spawnChild(...args) {
      const child = spawn(...args);
      pids.push(child.pid);
      return filterFrames(child, (frame) => frame.payload?.command !== 'ping' ? frame : null);
    }
  });
  t.after(() => session.stop());
  const terminal = once(session, 'terminal');
  const restarted = once(session, 'restarted');
  await session.start();
  await restarted;
  assert.deepEqual(await terminal, ['heartbeat-lost']);
  assert.equal(new Set(pids).size, 2);
});

test('device switch failure reports a muted state before the call faults on exit', { timeout: 5000 }, async (t) => {
  const session = new VoiceSession(fixture, {
    spawnChild(_helper, args, options) {
      return spawnFixture(args, options, 'device-switch-failure');
    }
  });
  t.after(() => session.stop());
  await session.start();
  assert.equal((await session.request('join', { muted: false })).muted, false);
  const terminal = once(session, 'terminal');
  const device = once(session, 'event');
  await assert.rejects(session.request('output-device', { outputDevice: 'test-output' }), {
    code: 'device-switch-failed'
  });
  assert.equal((await device)[0].payload.muted, true);
  assert.deepEqual(await terminal, ['helper-exited']);
  assert.equal(session.connection, null);
});

for (const [name, mutate, code] of [
  ['capture initialized', (frame) => { frame.payload.captureInitialized = true; return frame; }, 'bad-handshake'],
  ['wrong version', (frame) => { frame.v.major += 1; return frame; }, 'version-mismatch'],
  ['malformed frame', () => Buffer.from([1, 0, 0, 0, 255]), 'bad-frame']
]) {
  test(`native voice supervisor rejects ${name} during readiness`, { timeout: 5000 }, async (t) => {
    const session = new VoiceSession(fixture, {
      spawnChild(_helper, args, options) {
        return filterFrames(spawnFixture(args, options, 'normal'), (frame) => frame.kind === 'ready' ? mutate(frame) : frame);
      }
    });
    t.after(() => session.stop());
    await assert.rejects(session.start(), { code });
  });
}

for (const [name, replace, code] of [
  ['an unknown error code', (frame) => ({ ...frame, kind: 'error', payload: { command: 'ping', code: 'secret-marker' } }), 'bad-response'],
  ['an unexpected response field', (frame) => ({ ...frame, payload: { command: 'ping', data: { token: 'secret-marker' } } }), 'bad-response'],
  ['an unsafe device event', (frame) => ({ ...frame, id: 0, kind: 'device', payload: { captureEnabled: true } }), 'bad-event']
]) {
  test(`native voice supervisor rejects ${name}`, { timeout: 5000 }, async (t) => {
    const session = new VoiceSession(fixture, {
      spawnChild(_helper, args, options) {
        return filterFrames(spawnFixture(args, options, 'normal'), (frame) => frame.payload.command === 'ping' ? replace(frame) : frame);
      }
    });
    t.after(() => session.stop());
    const events = [];
    session.on('event', (event) => events.push(event));
    await session.start();
    await assert.rejects(session.request('ping'), { code, message: code });
    assert.deepEqual(events, []);
  });
}

for (const failed of [false, true]) {
  test(`stalled native voice child bounds Electron quit when termination ${failed ? 'fails' : 'succeeds'}`,
    { timeout: 5000 }, async (t) => {
      let killAttempts = 0;
      const session = new VoiceSession(fixture, {
        shutdownGraceMs: 30,
        shutdownDeadlineMs: 500,
        spawnChild(_helper, args, options) {
          const child = spawnFixture(args, options, 'stalled');
          const kill = child.kill.bind(child);
          t.after(() => kill());
          child.kill = () => {
            killAttempts += 1;
            return failed ? false : kill();
          };
          return child;
        }
      });
      await session.start();
      const { child } = session.connection;
      let finish;
      const finished = new Promise((resolve) => { finish = resolve; });
      const handleQuit = createVoiceQuitHandler({
        quit: () => finish('quit'),
        exit: () => finish('exit')
      }, () => session.stop());
      let prevented = 0;
      handleQuit({ preventDefault: () => { prevented += 1; } });
      handleQuit({ preventDefault: () => { prevented += 1; } });
      assert.equal(await finished, failed ? 'exit' : 'quit');
      assert.equal(prevented, 2);
      assert.equal(killAttempts, 1);
      assert.equal(session.connection?.child, failed ? child : undefined);
    });
}

test('failed native voice join emits fixed error without logging credentials', { ...windowsOnly, timeout: 20000 }, async (t) => {
  const link = connect(t);
  const stdout = [];
  const stderr = [];
  link.child.stdout.on('data', (chunk) => stdout.push(chunk));
  link.child.stderr.on('data', (chunk) => stderr.push(chunk));
  await handshake(link);
  const token = 'native-voice-test-secret-token';
  const url = 'ws://127.0.0.1:1/native-voice-test-secret-url';
  link.send(1, 'join', { payload: { token, url } });
  const reply = await link.next();
  // The SDK can exhaust its join deadline. Hosts without an audio endpoint
  // can reject even earlier. Every failure must keep both credentials private.
  assert.equal(reply.kind, 'error');
  assert.equal(reply.payload.command, 'join');
  assert.ok(['join-failed', 'join-timeout', 'device-unavailable'].includes(reply.payload.code), reply.payload.code);
  link.child.stdin.end();
  await link.exit;
  const output = Buffer.concat([...stdout, ...stderr]).toString();
  assert.ok(!output.includes(token) && !output.includes(url) && !output.includes('native-voice-test-secret-url'));
});

async function listenLoopback(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

for (const viaProxy of [false, true]) {
  test(`native voice reaches LiveKit signalling over WSS ${viaProxy ? 'via CONNECT' : 'directly'}`,
    { ...windowsOnly, timeout: 15000 }, async (t) => {
      // The loopback leaf has a public test key. The CA signing key was discarded.
      const tlsFixture = (name) => path.join(__dirname, 'fixtures', `native-voice-tls-${name}.pem`);
      const server = https.createServer({
        key: readFileSync(tlsFixture('loopback-key')),
        cert: readFileSync(tlsFixture('loopback-cert'))
      });
      const upgrades = [];
      server.on('upgrade', (request, socket) => {
        upgrades.push(new URL(request.url, 'https://localhost').pathname);
        const accept = createHash('sha1')
          .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        // Complete the upgrade, then close instead of sending a LiveKit JoinResponse.
        socket.end(Buffer.concat([
          Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`),
          Buffer.from([0x88, 0x02, 0x03, 0xe8])
        ]));
      });
      const signalPort = await listenLoopback(t, server);
      let proxyUrl = '';
      const targets = [];
      if (viaProxy) {
        const proxy = http.createServer();
        proxy.on('connect', (request, client, head) => {
          targets.push(request.url);
          const upstream = net.connect(signalPort, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            client.pipe(upstream).pipe(client);
          });
          upstream.on('error', () => client.destroy());
          client.on('error', () => upstream.destroy());
          client.on('close', () => upstream.destroy());
        });
        proxyUrl = `http://127.0.0.1:${await listenLoopback(t, proxy)}`;
      }
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(?:https?_proxy|all_proxy|ssl_cert_file|ssl_cert_dir)$/i.test(key)));
      env.HTTPS_PROXY = proxyUrl;
      env.SSL_CERT_FILE = tlsFixture('ca');
      const link = connect(t, process.pid, env);
      await handshake(link);
      link.send(1, 'join', { payload: {
        url: `wss://127.0.0.1:${signalPort}`, token: 'test-token', muted: true
      } });
      const reply = await link.next();
      link.child.stdin.end();
      assert.deepEqual(await link.exit, [0, null]);
      // Hosted Windows runners without an output endpoint fail before signalling.
      if (reply.payload.code === 'device-unavailable') return t.skip('No Windows audio output endpoint');
      assert.equal(reply.kind, 'error');
      assert.ok(upgrades.some((pathname) => /^\/rtc(?:\/v1)?$/.test(pathname)),
        `No LiveKit WebSocket upgrade reached the TLS server (${reply.payload.code})`);
      if (viaProxy) assert.ok(targets.includes(`127.0.0.1:${signalPort}`));
    });
}

test('native voice watchdog exits after owning process dies with stdin held open', windowsOnly, async (t) => {
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  t.after(() => owner.kill());
  await once(owner, 'spawn');
  const link = connect(t, owner.pid);
  await handshake(link);
  assert.ok(owner.kill());
  assert.equal(link.child.stdin.writableEnded, false);
  assert.deepEqual(await link.exit, [0, null]);
});
