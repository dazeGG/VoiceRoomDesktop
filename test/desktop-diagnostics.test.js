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
  summarizeAppMetrics,
  summarizeGpuStatus
} = require('../electron/diagnostics');

const LOG_FILE = path.join('C:', 'Users', 'secret-user', 'AppData', 'Roaming', 'Voice Room', 'logs', 'main.log');

function createHarness(overrides = {}) {
  const copied = [];
  const opened = [];
  const handlers = new Map();
  const controller = createDiagnosticsController({
    app: {
      getAppMetrics: () => [
        { type: 'Browser', cpu: { percentCPUUsage: 1.24 }, memory: { workingSetSize: 102400 } },
        { type: 'Tab', cpu: { percentCPUUsage: 2.5 }, memory: { workingSetSize: 204800 } },
        { type: 'GPU', cpu: { percentCPUUsage: 0.5 }, memory: { workingSetSize: 51200 } }
      ],
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
    getStreamHealth: () => ({
      audio: { active: true, restarts: 1, target: 'app' },
      capture: { active: false, endReason: 'exited', restarts: 3, sourceType: 'screen' },
      gpuCrashes: 1,
      overlay: { enabled: true, game: 'cs2.exe', visible: true, watcher: 'native' }
    }),
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

  it('sums process CPU and memory by type and ignores garbage', () => {
    assert.deepEqual(summarizeAppMetrics([
      { type: 'Tab', cpu: { percentCPUUsage: 3 }, memory: { workingSetSize: 2048 } },
      { type: 'Tab', cpu: { percentCPUUsage: 1.1 }, memory: { workingSetSize: 1024 } },
      { type: 'C:\\evil path', cpu: { percentCPUUsage: -1 }, memory: { workingSetSize: 'x' } },
      null
    ]), {
      byType: {
        Tab: { count: 2, cpuPercent: 4.1, memoryMb: 3 },
        Unknown: { count: 2, cpuPercent: 0, memoryMb: 0 }
      },
      count: 4,
      cpuPercent: 4.1,
      memoryMb: 3
    });
    assert.deepEqual(summarizeAppMetrics(undefined), { byType: {}, count: 0, cpuPercent: 0, memoryMb: 0 });
  });
});

describe('desktop diagnostics performance log', () => {
  it('logs one process line per interval and stops', () => {
    const lines = [];
    let tick = null;
    let cleared = false;
    const { controller } = createHarness({
      log: { info: (line) => lines.push(line), warn() {}, transports: { file: { getFile: () => ({ path: LOG_FILE }) } } }
    });
    const stop = controller.startPerformanceLog({
      intervalMs: 5,
      timers: {
        clearInterval: () => { cleared = true; },
        setInterval: (callback) => { tick = callback; return { unref() {} }; }
      }
    });
    tick();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Performance: voice=yes, processes: 3, cpu 4\.2% of a core, memory 350 MB/);
    stop();
    assert.equal(cleared, true);
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
      'stream capture: idle, last=screen, end=exited, restarts=3',
      'stream audio: active (app), restarts=1',
      'overlay: on, watcher=native, visible=yes, game=cs2.exe',
      'gpu process crashes: 1',
      'processes: 3, cpu 4.2% of a core, memory 350 MB (Browser 1: 1.2% 100 MB; GPU 1: 0.5% 50 MB; Tab 1: 2.5% 200 MB)',
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

  it('keeps only plain tokens in the stream health lines', () => {
    const { controller } = createHarness({
      getStreamHealth: () => ({
        audio: { active: false, lastExitCode: 3, restarts: -1, target: 'C:\\Users\\secret-user' },
        capture: { active: true, restarts: 'many', sourceType: 'window' },
        overlay: { enabled: true, game: 'D:\\Games\\secret-user\\game.exe', visible: false, watcher: 'powershell' }
      })
    });
    const { text } = controller.getInfo();

    assert.doesNotMatch(text, /secret-user/);
    assert.match(text, /stream capture: active \(window\), restarts=0/);
    assert.match(text, /stream audio: idle, last=-, exit=3, restarts=0/);
    assert.match(text, /overlay: on, watcher=powershell, visible=no, game=-/);
    assert.match(text, /gpu process crashes: 0/);
  });

  it('survives failing probes', () => {
    const { controller } = createHarness({
      getAutostartSettings: () => { throw new Error('boom'); },
      getStreamHealth: () => { throw new Error('boom'); },
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

  it('reports a clipboard that refused the copy instead of throwing', async () => {
    const { invoke } = createHarness({ clipboard: { writeText: () => Promise.reject(new Error('busy')) } });
    assert.deepEqual(await invoke(COPY_INFO_CHANNEL), { ok: false, reason: 'clipboard-failed' });
  });

  it('copies the text and opens the logs folder over trusted IPC', async () => {
    const { copied, invoke, opened } = createHarness();

    assert.deepEqual(invoke(SET_CONTEXT_CHANNEL, { roomId: 'abc', userId: 'u1' }), { roomId: 'abc', userId: 'u1' });
    assert.deepEqual(await invoke(COPY_INFO_CHANNEL), { ok: true });
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
