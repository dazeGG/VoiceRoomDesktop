'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHmac, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdirSync, writeFileSync, renameSync, rmSync } = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { VoiceSession } = require('../electron/native/voice');

const livekit = process.env.VR_VOICE_TEST_LIVEKIT;
const target = path.resolve(__dirname, '..', 'native', 'voice', process.env.CARGO_TARGET_DIR || 'target',
  'x86_64-pc-windows-msvc', 'release');
const helper = path.join(target, 'voiceroom-voice.exe');
const sender = path.join(target, 'examples', 'smoke_sender.exe');
const port = 18990;
const base = 'http://127.0.0.1:' + port;
const url = base.replace('http:', 'ws:');

function jwt(room, identity, publish) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 180;
  const video = { room, roomJoin: true, canPublish: publish, canSubscribe: !publish, canPublishData: false };
  const body = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ iss: 'devkey', sub: identity, exp, video });
  return body + '.' + createHmac('sha256', 'secret').update(body).digest('base64url');
}

async function until(check, failure, timeout = 6000) {
  const deadline = performance.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(30);
  } while (performance.now() < deadline);
  assert.fail(failure);
}

function childProcess(t, exe, args, stdio) {
  const child = spawn(exe, args, { windowsHide: true, stdio });
  const exit = once(child, 'close');
  // Mark the promise handled until t.after collects any process error.
  exit.catch(() => {});
  t.after(async () => {
    child.kill();
    await exit;
  });
  return child;
}

async function publisher(t, room, identity, amplitude) {
  const child = childProcess(t, sender, [url, String(amplitude)], ['pipe', 'pipe', 'inherit']);
  const lines = createInterface({ input: child.stdout });
  function publish(command) {
    const result = once(lines, 'line', { signal: AbortSignal.timeout(12000) });
    child.stdin.write(command + '\n');
    return result.then(([sid]) => {
      assert.match(sid, /^TR_/);
      return sid;
    });
  }
  return { sid: await publish(jwt(room, identity, true)), republish: () => publish('republish') };
}

function startHelper(t, endpointFile) {
  const rows = [];
  const events = [];
  const env = { ...process.env, VR_VOICE_TEST_ENDPOINTS: endpointFile, VR_VOICE_TEST_VIRTUAL_OUTPUTS: '1' };
  const session = new VoiceSession(helper, {
    callScoped: true,
    shutdownGraceMs: 2300,
    shutdownDeadlineMs: 2500,
    spawnChild(exe, args, options) {
      const child = spawn(exe, args, { ...options, env, stdio: ['pipe', 'pipe', 'pipe'] });
      createInterface({ input: child.stderr }).on('line', (line) => {
        if (line.startsWith('voice-test ')) rows.push(line.trim().split(' ').slice(1));
      });
      return child;
    }
  });
  session.on('event', (frame) => events.push(frame));
  t.after(() => session.stop());
  return { session, rows, events };
}

function sourceRows(rows, start = 0) {
  return rows.slice(start).filter(([kind]) => kind === 'source')
    .map(([, ssrc, input, output]) => ({ ssrc, input: Number(input), output: Number(output) }));
}

function statAfter(events, from, check) {
  return events.slice(from).find(({ kind, payload }) => kind === 'stats' && check(payload))?.payload;
}

function deviceAfter(events, from, check) {
  return events.slice(from).find(({ kind, payload }) => kind === 'device' && check(payload))?.payload;
}

function endpoint(id, isDefault = false) {
  return { id: 'test-output:' + id, name: id, isDefault };
}

test('native helper receive, gain admission and output recovery in a LiveKit room', {
  skip: !livekit && 'set VR_VOICE_TEST_LIVEKIT and build the receive-test helper and examples',
  timeout: 100000
}, async (t) => {
  const room = 'native-receive-' + randomUUID();
  const work = path.join(target, room);
  mkdirSync(work);
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const endpointFile = path.join(work, 'outputs.json');
  function snapshot(outputs) {
    writeFileSync(endpointFile + '.next', JSON.stringify(outputs));
    renameSync(endpointFile + '.next', endpointFile);
  }
  const fallback = endpoint('fallback', true);
  const failed = endpoint('failed');
  const selected = endpoint('selected');
  snapshot([fallback]);
  const serverConfig = [
    'port: ' + port,
    'rtc:',
    '  tcp_port: ' + (port + 1),
    '  udp_port: ' + (port + 2),
    '  use_external_ip: false'
  ].join('\n');
  const server = childProcess(t, livekit, [
    '--dev', '--config-body', serverConfig, '--bind', '127.0.0.1', '--node-ip', '127.0.0.1'
  ], ['ignore', 'ignore', 'ignore']);
  await until(() => {
    assert.equal(server.exitCode, null, 'LiveKit exited during startup');
    return fetch(base, { signal: AbortSignal.timeout(500) }).then((reply) => reply.ok, () => false);
  }, 'LiveKit did not start');

  const speaker = await publisher(t, room, 'speaker', 1000);
  const second = await publisher(t, room, 'second', 16000);
  const own = await publisher(t, room, 'listener', 24000);
  const { session, rows, events } = startHelper(t, endpointFile);
  await session.start();
  const token = jwt(room, 'listener#voice.regression', false);
  const tracks = [speaker.sid, own.sid];
  const joined = await session.request('join', { url, token, tracks, muted: false });
  assert.equal(joined.effectiveOutputDevice, fallback.id);

  const audible = await until(() => sourceRows(rows).find((row) => row.output > 400), 'baseline microphone never rendered');
  const quiet = audible.ssrc;
  await until(() => statAfter(events, 0, ({ totalSamplesReceived }) => totalSamplesReceived > 40000), 'no baseline receive stats');
  assert.ok(sourceRows(rows).every(({ ssrc }) => ssrc === quiet), 'own microphone was subscribed');

  async function subscribeSilent(sid) {
    const from = rows.length;
    await session.request('update', {
      tracks: [...tracks, sid], volumes: { [sid]: 0 }
    });
    await until(() => sourceRows(rows, from).filter(({ ssrc, input }) => ssrc !== quiet && input > 5000).length >= 20,
      'never received the new microphone while the first was audible');
    const frames = sourceRows(rows, from);
    assert.ok(frames.some(({ ssrc, output }) => ssrc === quiet && output > 0), 'existing microphone fell silent');
    assert.ok(frames.filter(({ ssrc }) => ssrc !== quiet).every(({ output }) => output === 0),
      'new microphone rendered above zero, including during admission');
    return frames.find(({ ssrc, input }) => ssrc !== quiet && input > 5000).ssrc;
  }

  await subscribeSilent(second.sid);
  await session.request('update', { tracks });
  // Wait until the old subscribed stream has drained before capturing resubscribe onset.
  await delay(750);
  const drained = rows.length;
  await delay(200);
  assert.ok(sourceRows(rows, drained).every(({ ssrc }) => ssrc === quiet), 'unsubscribed microphone is still rendering');
  const previousLoud = await subscribeSilent(second.sid);

  // Prove the new publication starts silent even after the previous one played.
  const beforeRepublish = rows.length;
  await session.request('update', { volumes: {} });
  await until(() => sourceRows(rows, beforeRepublish).some(({ ssrc, output }) =>
    ssrc === previousLoud && output > 10000), 'original publication never rendered before republish');
  const replacement = await second.republish();
  assert.notEqual(replacement, second.sid);
  await delay(750);
  const loud = await subscribeSilent(replacement);
  assert.notEqual(loud, previousLoud, 'replacement must be measured on its own receiver');
  const loudTracks = [...tracks, replacement];

  let from = rows.length;
  await session.request('update', { tracks: [replacement], masterVolume: 2, volumes: { [replacement]: 2 } });
  const boosted = await until(() => sourceRows(rows, from).find(({ ssrc, input, output }) =>
    ssrc === loud && input > 11000 && output >= 30000), 'loud source did not receive requested boost')
    .catch((error) => {
      t.diagnostic(JSON.stringify(sourceRows(rows, from).slice(-30)));
      throw error;
    });
  assert.ok(boosted.output <= 32112, 'source boost saturated the decoded waveform');
  await until(() => sourceRows(rows, from).filter(({ ssrc, input }) => ssrc === loud && input > 11000).length > 15,
    'loud source did not sustain input');
  assert.ok(sourceRows(rows, from).filter(({ ssrc }) => ssrc === loud)
    .every(({ output }) => output < 32767), 'single-source PCM reached the clipping rails');

  await session.request('update', { masterVolume: 1, volumes: { [replacement]: 0.995 } });
  from = rows.length;
  await until(() => sourceRows(rows, from).filter(({ ssrc, input }) => ssrc === loud && input > 11000).length > 10,
    'no input for near-unity attenuation');
  assert.ok(sourceRows(rows, from).filter(({ ssrc, input }) => ssrc === loud && input > 11000)
    .every(({ input, output }) => output === Math.trunc(input * 0.995)), 'gain near unity was ignored');

  from = rows.length;
  await session.request('update', { tracks: loudTracks, masterVolume: 2, volumes: { [replacement]: 2, [speaker.sid]: 2 } });
  await until(() => {
    const frames = sourceRows(rows, from);
    return new Set(frames.filter(({ output }) => output > 2000).map(({ ssrc }) => ssrc)).size === 2;
  }, 'both microphones did not contribute to the boosted mix');
  from = rows.length;
  await until(() => rows.slice(from).filter(([kind]) => kind === 'mix').length > 20, 'boosted mix did not render');
  const mix = rows.slice(from).filter(([kind]) => kind === 'mix').map(([, peak]) => Number(peak));
  assert.ok(mix.every((peak) => peak > 10000 && peak < 32767), 'multi-source mixer clipped or stopped');
  await session.request('update', { masterVolume: 1, volumes: { [replacement]: 0 } });

  snapshot([fallback, failed]);
  from = rows.length;
  const failedSelection = await session.request('output-device', { outputDevice: failed.id });
  assert.equal(failedSelection.effectiveOutputDevice, fallback.id);
  assert.equal(failedSelection.fallback, 'selected-output-unavailable');
  await until(() => rows.slice(from).filter((row) => row.join(' ') === 'route failed ' + failed.id).length >= 3,
    'the helper did not retry the still-listed failed endpoint twice', 13500);
  assert.ok(rows.slice(from).every(([kind, action]) => kind !== 'route' || action === 'failed'),
    'retry stopped or reopened the already-working fallback route');
  assert.ok(rows.slice(from).filter(([kind, value]) => kind === 'mix' && Number(value) > 300).length > 100,
    'fallback stopped receiving audio during retries');

  snapshot([fallback, selected]);
  assert.equal((await session.request('output-device', { outputDevice: selected.id })).effectiveOutputDevice, selected.id);
  for (const muted of [false, true]) {
    await session.request('output-mute', { muted });
    const fromEvent = events.length;
    from = rows.length;
    snapshot([]);
    const lost = await until(() => deviceAfter(events, fromEvent, ({ effectiveOutputDevice }) => effectiveOutputDevice === null),
      'no device event with a null effective endpoint');
    assert.equal(lost.muted, muted);
    assert.equal(lost.outputDevice, selected.id);
    const outage = await until(() => statAfter(events, fromEvent, () => true), 'receive stats disappeared during outage');
    await until(() => statAfter(events, fromEvent, (stats) => stats.totalSamplesReceived > outage.totalSamplesReceived),
      'receive stopped during outage');
    const restoreEvent = events.length;
    snapshot([fallback, selected]);
    const restored = await until(() => deviceAfter(events, restoreEvent,
      ({ effectiveOutputDevice }) => effectiveOutputDevice === selected.id), 'selected endpoint was not restored');
    assert.equal(restored.muted, muted);
    assert.equal(restored.fallback, null);
    const reopened = () => rows.slice(from).some((row) => row.join(' ') === 'route opened ' + selected.id);
    if (muted) {
      await delay(200);
      assert.equal(reopened(), false, 'restoration opened a render route while deafened');
    } else {
      await until(reopened, 'restoration never started the selected render route');
    }
  }

  assert.equal((await session.request('output-mute', { muted: false })).effectiveOutputDevice, selected.id);
  const { child } = session.connection;
  from = rows.length;
  await session.stop();
  assert.equal(child.exitCode, 0, 'shutdown killed a joined helper instead of waiting for its exit');
  assert.ok(rows.slice(from).some((row) => row.join(' ') === 'route stopped'), 'shutdown did not stop the active render route');

  snapshot([]);
  const expired = startHelper(t, endpointFile);
  await expired.session.start();
  const terminal = once(expired.session, 'terminal', { signal: AbortSignal.timeout(37000) });
  // A different native identity allows the earlier helper to disconnect independently.
  const started = performance.now();
  const unavailable = await expired.session.request('join', {
    url, token: jwt(room, 'other#voice.regression', false), tracks: [speaker.sid], muted: false
  });
  assert.equal(unavailable.effectiveOutputDevice, null);
  await until(() => statAfter(expired.events, 0, ({ totalSamplesReceived }) => totalSamplesReceived > 0), 'outage prevented receive');
  assert.deepEqual(await terminal, ['output-not-rendering']);
  assert.ok(performance.now() - started >= 29500, 'continuous outage ended before the recovery window');
});
