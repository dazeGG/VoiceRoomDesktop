'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  COPY_INFO_CHANNEL,
  GET_INFO_CHANNEL,
  OPEN_LOGS_CHANNEL,
  SET_CONTEXT_CHANNEL,
  createDiagnosticsController,
  resolvePackageType,
  sanitizeContextId,
  summarizeGpuStatus
} = require('../electron/diagnostics');

const LOG_FILE = path.join('C:', 'Users', 'secret-user', 'AppData', 'Roaming', 'Voice Room', 'logs', 'main.log');

function createHarness(overrides = {}) {
  const copied = [];
  const opened = [];
  const handlers = new Map();
  const controller = createDiagnosticsController({
    app: {
      getAppPath: () => path.join('C:', 'Users', 'secret-user', 'app'),
      getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled', video_decode: 'enabled', '2d_canvas': 'enabled' }),
      getLocale: () => 'ru',
      getVersion: () => '1.3.0',
      isPackaged: true
    },
    arch: 'x64',
    clipboard: { writeText: (text) => copied.push(text) },
    env: {},
    getAutostartSettings: () => ({ openAtLogin: true, startMinimized: true, supported: true }),
    getHotkeysBackend: () => 'native',
    getNativeHelpers: () => ({ audio: true, capture: false, hotkeys: true }),
    getUpdateState: () => ({ phase: 'ready', version: '1.3.1' }),
    isVoiceActive: () => true,
    log: { transports: { file: { getFile: () => ({ path: LOG_FILE }) } }, warn() {} },
    now: () => new Date('2026-09-11T10:00:00.000Z'),
    osRelease: () => '10.0.26200',
    platform: 'win32',
    readBuildProfile: () => ({ channel: 'release' }),
    shell: {
      openPath: async (target) => {
        opened.push(target);
        return overrides.openPathError || '';
      }
    },
    versions: { chrome: '146.0.0.0', electron: '41.10.2', node: '24.1.0' },
    ...overrides
  });
  controller.configureIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isTrustedFrame: (frame) => frame?.trusted === true
  });
  const invoke = (channel, ...args) => handlers.get(channel)({ senderFrame: { trusted: true } }, ...args);
  return { controller, copied, handlers, invoke, opened };
}

describe('desktop diagnostics helpers', () => {
  it('accepts only compact identifiers as web context', () => {
    assert.equal(sanitizeContextId('user_42'), 'user_42');
    assert.equal(sanitizeContextId('Ab3-xY'), 'Ab3-xY');
    assert.equal(sanitizeContextId('a b'), '');
    assert.equal(sanitizeContextId('C:\\Users\\x'), '');
    assert.equal(sanitizeContextId('x'.repeat(129)), '');
    assert.equal(sanitizeContextId(42), '');
  });

  it('detects the package type', () => {
    assert.equal(resolvePackageType({ isPackaged: false, platform: 'win32' }), 'unpackaged');
    assert.equal(resolvePackageType({ isPackaged: true, platform: 'win32', env: {} }), 'nsis');
    assert.equal(resolvePackageType({ isPackaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'x.exe' } }), 'portable');
    assert.equal(resolvePackageType({ isPackaged: true, platform: 'darwin' }), 'mac');
  });

  it('summarizes known GPU features only', () => {
    assert.equal(summarizeGpuStatus({ webgl: 'enabled', gpu_compositing: 'disabled_software', other: 'x' }), 'gpu_compositing=disabled_software, webgl=enabled');
    assert.equal(summarizeGpuStatus(null), 'unknown');
  });
});

describe('desktop diagnostics controller', () => {
  it('collects a technical snapshot with the web context', () => {
    const { controller } = createHarness();
    controller.setContext({ roomId: 'room-1', userId: 'user-7' });
    const info = controller.getInfo();

    assert.deepEqual(info.app, { channel: 'stable', packageType: 'nsis', version: '1.3.0' });
    assert.equal(info.hotkeysBackend, 'native');
    assert.deepEqual(info.nativeHelpers, { audio: true, capture: false, hotkeys: true });
    assert.deepEqual(info.update, { phase: 'ready', version: '1.3.1' });
    assert.deepEqual(info.context, { roomId: 'room-1', userId: 'user-7' });
    assert.equal(info.voiceActive, true);
    assert.equal(info.text, [
      'Voice Room Desktop diagnostics',
      'generated: 2026-09-11T10:00:00.000Z',
      'app: 1.3.0 (stable, nsis)',
      'electron: 41.10.2, chromium: 146.0.0.0, node: 24.1.0',
      'os: win32 10.0.26200 x64, locale: ru',
      'gpu: gpu_compositing=enabled, video_decode=enabled',
      'native helpers: audio=yes, capture=no, hotkeys=yes',
      'hotkeys backend: native',
      'update: ready 1.3.1',
      'autostart: yes (minimized)',
      'voice active: yes',
      'user: user-7',
      'room: room-1'
    ].join('\n'));
  });

  it('never leaks filesystem paths or the OS user name', () => {
    const { controller } = createHarness();
    controller.setContext({ roomId: 'C:\\Users\\secret-user', userId: '/home/secret-user' });
    const { text } = controller.getInfo();

    assert.doesNotMatch(text, /secret-user/);
    assert.doesNotMatch(text, /[A-Za-z]:\\|\/Users\/|\/home\//);
    assert.match(text, /user: -\nroom: -$/);
  });

  it('survives failing probes', () => {
    const { controller } = createHarness({
      getAutostartSettings: () => { throw new Error('boom'); },
      getNativeHelpers: () => { throw new Error('boom'); },
      getUpdateState: () => null,
      readBuildProfile: () => { throw new Error('boom'); }
    });
    const info = controller.getInfo();

    assert.equal(info.update.phase, 'disabled');
    assert.equal(info.autostart.supported, false);
    assert.deepEqual(info.nativeHelpers, { audio: false, capture: false, hotkeys: false });
    assert.match(info.text, /autostart: unsupported/);
  });

  it('copies the text and opens the logs folder over trusted IPC', async () => {
    const { copied, invoke, opened } = createHarness();

    assert.deepEqual(invoke(SET_CONTEXT_CHANNEL, { roomId: 'abc', userId: 'u1' }), { roomId: 'abc', userId: 'u1' });
    assert.deepEqual(invoke(COPY_INFO_CHANNEL), { ok: true });
    assert.match(copied[0], /room: abc/);
    assert.equal(invoke(GET_INFO_CHANNEL).context.userId, 'u1');
    assert.deepEqual(await invoke(OPEN_LOGS_CHANNEL), { ok: true });
    assert.deepEqual(opened, [path.dirname(LOG_FILE)]);
  });

  it('reports a logs folder that could not be opened', async () => {
    const { controller } = createHarness({ openPathError: 'No application' });
    assert.deepEqual(await controller.openLogsFolder(), { ok: false, reason: 'open-failed' });
  });

  it('rejects untrusted frames', () => {
    const { handlers } = createHarness();
    for (const channel of [GET_INFO_CHANNEL, COPY_INFO_CHANNEL, OPEN_LOGS_CHANNEL, SET_CONTEXT_CHANNEL]) {
      assert.throws(
        () => handlers.get(channel)({ senderFrame: { trusted: false } }),
        /Desktop diagnostics are only available for the configured Voice Room URL\./
      );
    }
  });
});
