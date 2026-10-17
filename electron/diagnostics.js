'use strict';

const path = require('node:path');

const GET_INFO_CHANNEL = 'desktop-diagnostics:get-info';
const COPY_INFO_CHANNEL = 'desktop-diagnostics:copy-info';
const OPEN_LOGS_CHANNEL = 'desktop-diagnostics:open-logs';
const SET_CONTEXT_CHANNEL = 'desktop-diagnostics:set-context';
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const GPU_FEATURES = ['gpu_compositing', 'rasterization', 'video_decode', 'video_encode', 'webgl', 'webgpu'];

function sanitizeContextId(value) {
  return typeof value === 'string' && CONTEXT_ID_PATTERN.test(value) ? value : '';
}

function resolvePackageType({ env = {}, isPackaged, platform }) {
  if (!isPackaged) return 'unpackaged';
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'nsis';
  return platform;
}

function summarizeGpuStatus(status) {
  if (!status || typeof status !== 'object') return 'unknown';
  const parts = GPU_FEATURES
    .filter((feature) => typeof status[feature] === 'string')
    .map((feature) => `${feature}=${status[feature]}`);
  return parts.length ? parts.join(', ') : 'unknown';
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

const HEALTH_TOKEN_PATTERN = /^[a-z0-9._-]{1,64}$/i;

function healthToken(value, fallback = '-') {
  return typeof value === 'string' && HEALTH_TOKEN_PATTERN.test(value) ? value : fallback;
}

function healthCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

// Stream and overlay state reduced to plain tokens: support reads it to tell a
// crashing helper from a network problem, and it never carries paths or names.
function sanitizeStreamHealth(health) {
  const source = health && typeof health === 'object' ? health : {};
  const capture = source.capture && typeof source.capture === 'object' ? source.capture : {};
  const audio = source.audio && typeof source.audio === 'object' ? source.audio : {};
  const overlay = source.overlay && typeof source.overlay === 'object' ? source.overlay : {};
  return {
    audio: {
      active: audio.active === true,
      lastExitCode: Number.isInteger(audio.lastExitCode) ? audio.lastExitCode : null,
      restarts: healthCount(audio.restarts),
      target: healthToken(audio.target)
    },
    capture: {
      active: capture.active === true,
      endReason: healthToken(capture.endReason),
      restarts: healthCount(capture.restarts),
      sourceType: healthToken(capture.sourceType)
    },
    gpuCrashes: healthCount(source.gpuCrashes),
    overlay: {
      enabled: overlay.enabled === true,
      game: healthToken(overlay.game),
      visible: overlay.visible === true,
      watcher: healthToken(overlay.watcher, 'none')
    }
  };
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Chromium's own processes (main, renderers, GPU, utilities) from
// app.getAppMetrics(): CPU is a percentage of one core since the previous
// reading, memory the working set. The native helpers are separate executables
// and not part of it.
function summarizeAppMetrics(metrics) {
  const list = Array.isArray(metrics) ? metrics : [];
  const byType = {};
  let cpuPercent = 0;
  let memoryKb = 0;
  for (const metric of list) {
    const type = typeof metric?.type === 'string' && HEALTH_TOKEN_PATTERN.test(metric.type) ? metric.type : 'Unknown';
    const entry = byType[type] || (byType[type] = { count: 0, cpuPercent: 0, memoryMb: 0 });
    entry.count += 1;
    const cpu = Number(metric?.cpu?.percentCPUUsage);
    if (Number.isFinite(cpu) && cpu >= 0) {
      entry.cpuPercent += cpu;
      cpuPercent += cpu;
    }
    const memory = Number(metric?.memory?.workingSetSize);
    if (Number.isFinite(memory) && memory >= 0) {
      entry.memoryMb += memory / 1024;
      memoryKb += memory;
    }
  }
  for (const entry of Object.values(byType)) {
    entry.cpuPercent = roundTo(entry.cpuPercent, 1);
    entry.memoryMb = Math.round(entry.memoryMb);
  }
  return {
    byType,
    count: list.length,
    cpuPercent: roundTo(cpuPercent, 1),
    memoryMb: Math.round(memoryKb / 1024)
  };
}

function formatProcessLine(processes) {
  const parts = Object.entries(processes.byType)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, entry]) => `${type} ${entry.count}: ${entry.cpuPercent}% ${entry.memoryMb} MB`);
  return `processes: ${processes.count}, cpu ${processes.cpuPercent}% of a core, memory ${processes.memoryMb} MB${parts.length ? ` (${parts.join('; ')})` : ''}`;
}

function formatStreamHealthLines(health) {
  const { audio, capture, gpuCrashes, overlay } = health;
  const captureState = capture.active
    ? `active (${capture.sourceType})`
    : `idle, last=${capture.sourceType}, end=${capture.endReason}`;
  const audioState = audio.active
    ? `active (${audio.target})`
    : `idle, last=${audio.target}, exit=${audio.lastExitCode ?? '-'}`;
  return [
    `stream capture: ${captureState}, restarts=${capture.restarts}`,
    `stream audio: ${audioState}, restarts=${audio.restarts}`,
    `overlay: ${overlay.enabled ? 'on' : 'off'}, watcher=${overlay.watcher}, visible=${yesNo(overlay.visible)}, game=${overlay.game}`,
    `gpu process crashes: ${gpuCrashes}`
  ];
}

// Plain "key: value" lines: easy to paste into a chat and to grep for.
function formatDiagnosticsText(info) {
  return [
    'VoiceRoom Desktop diagnostics',
    `generated: ${info.generatedAt}`,
    `app: ${info.app.version} (${info.app.channel}, ${info.app.packageType})`,
    `electron: ${info.runtime.electron}, chromium: ${info.runtime.chromium}, node: ${info.runtime.node}`,
    `os: ${info.os.platform} ${info.os.release} ${info.os.arch}, locale: ${info.os.locale}`,
    `gpu: ${info.gpu}`,
    `native helpers: audio=${yesNo(info.nativeHelpers.audio)}, capture=${yesNo(info.nativeHelpers.capture)}, hotkeys=${yesNo(info.nativeHelpers.hotkeys)}`,
    `hotkeys backend: ${info.hotkeysBackend}`,
    ...formatStreamHealthLines(info.streamHealth || sanitizeStreamHealth(null)),
    formatProcessLine(info.processes || summarizeAppMetrics(null)),
    `update: ${info.update.phase}${info.update.version ? ` ${info.update.version}` : ''}`,
    `autostart: ${info.autostart.supported ? yesNo(info.autostart.openAtLogin) : 'unsupported'}${info.autostart.startMinimized ? ' (minimized)' : ''}`,
    `voice active: ${yesNo(info.voiceActive)}`,
    `user: ${info.context.userId || '-'}`,
    `room: ${info.context.roomId || '-'}`
  ].join('\n');
}

function createDiagnosticsController({
  app,
  clipboard,
  shell,
  log,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  versions = process.versions,
  osRelease,
  readBuildProfile = () => null,
  getNativeHelpers = () => ({}),
  getUpdateState = () => null,
  getAutostartSettings = () => null,
  getHotkeysBackend = () => 'none',
  getStreamHealth = () => null,
  isVoiceActive = () => false,
  now = () => new Date()
}) {
  let context = { roomId: '', userId: '' };

  function safely(read, fallback) {
    try {
      return read() ?? fallback;
    } catch (error) {
      log?.warn?.('Diagnostics probe failed:', error);
      return fallback;
    }
  }

  function getInfo() {
    const profile = safely(() => readBuildProfile(app.getAppPath()), null);
    const helpers = safely(getNativeHelpers, {});
    const update = safely(getUpdateState, null);
    const autostart = safely(getAutostartSettings, null);
    const info = {
      app: {
        channel: profile?.channel === 'dev' ? 'dev' : app.isPackaged ? 'stable' : 'local',
        packageType: resolvePackageType({ env, isPackaged: app.isPackaged, platform }),
        version: app.getVersion()
      },
      autostart: {
        openAtLogin: autostart?.openAtLogin === true,
        startMinimized: autostart?.startMinimized === true,
        supported: autostart?.supported === true
      },
      context: { ...context },
      generatedAt: now().toISOString(),
      gpu: summarizeGpuStatus(safely(() => app.getGPUFeatureStatus(), null)),
      hotkeysBackend: String(safely(getHotkeysBackend, 'none') || 'none'),
      nativeHelpers: {
        audio: helpers.audio === true,
        capture: helpers.capture === true,
        hotkeys: helpers.hotkeys === true
      },
      os: {
        arch,
        locale: safely(() => app.getLocale(), '') || 'unknown',
        platform,
        release: safely(() => (osRelease ? osRelease() : require('node:os').release()), 'unknown')
      },
      streamHealth: sanitizeStreamHealth(safely(getStreamHealth, null)),
      processes: summarizeAppMetrics(safely(() => app.getAppMetrics?.(), null)),
      runtime: {
        chromium: versions.chrome || 'unknown',
        electron: versions.electron || 'unknown',
        node: versions.node || 'unknown'
      },
      update: {
        phase: typeof update?.phase === 'string' ? update.phase : 'disabled',
        version: typeof update?.version === 'string' ? update.version : ''
      },
      voiceActive: safely(isVoiceActive, false) === true
    };
    return { ...info, text: formatDiagnosticsText(info) };
  }

  // Electron 44's clipboard is asynchronous; a failed write is reported, not thrown.
  async function copyInfo() {
    const { text } = getInfo();
    try {
      await clipboard.writeText(text);
      return { ok: true };
    } catch (error) {
      log?.warn?.('Failed to copy diagnostics:', error);
      return { ok: false, reason: 'clipboard-failed' };
    }
  }

  async function openLogsFolder() {
    const logFile = safely(() => log.transports.file.getFile().path, '');
    if (!logFile) return { ok: false, reason: 'unavailable' };
    const error = await shell.openPath(path.dirname(logFile));
    if (error) {
      log?.warn?.('Failed to open the logs folder:', error);
      return { ok: false, reason: 'open-failed' };
    }
    return { ok: true };
  }

  // VOICE_ROOM_PERF_LOG=1: one line of process CPU and memory every interval,
  // so a before/after comparison of a call, the tray or a game is a log grep.
  function startPerformanceLog({ intervalMs = 10_000, timers = { setInterval, clearInterval } } = {}) {
    const timer = timers.setInterval(() => {
      const processes = summarizeAppMetrics(safely(() => app.getAppMetrics?.(), null));
      log?.info?.(`Performance: voice=${yesNo(safely(isVoiceActive, false) === true)}, ${formatProcessLine(processes)}`);
    }, intervalMs);
    timer?.unref?.();
    return () => timers.clearInterval(timer);
  }

  function setContext(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    context = {
      roomId: sanitizeContextId(source.roomId),
      userId: sanitizeContextId(source.userId)
    };
    return { ...context };
  }

  function configureIpc({ ipcMain, isTrustedFrame }) {
    const trusted = (handler) => (event, ...args) => {
      if (!isTrustedFrame(event.senderFrame)) {
        throw new Error('Desktop diagnostics are only available for the configured VoiceRoom URL.');
      }
      return handler(...args);
    };

    ipcMain.handle(GET_INFO_CHANNEL, trusted(getInfo));
    ipcMain.handle(COPY_INFO_CHANNEL, trusted(copyInfo));
    ipcMain.handle(OPEN_LOGS_CHANNEL, trusted(openLogsFolder));
    ipcMain.handle(SET_CONTEXT_CHANNEL, trusted(setContext));
  }

  return {
    configureIpc,
    copyInfo,
    getInfo,
    openLogsFolder,
    setContext,
    startPerformanceLog
  };
}

module.exports = {
  COPY_INFO_CHANNEL,
  GET_INFO_CHANNEL,
  OPEN_LOGS_CHANNEL,
  SET_CONTEXT_CHANNEL,
  createDiagnosticsController,
  formatDiagnosticsText,
  resolvePackageType,
  sanitizeContextId,
  sanitizeStreamHealth,
  summarizeAppMetrics,
  summarizeGpuStatus
};
