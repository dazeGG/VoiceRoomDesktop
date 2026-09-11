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

// Plain "key: value" lines: easy to paste into a chat and to grep for.
function formatDiagnosticsText(info) {
  return [
    'Voice Room Desktop diagnostics',
    `generated: ${info.generatedAt}`,
    `app: ${info.app.version} (${info.app.channel}, ${info.app.packageType})`,
    `electron: ${info.runtime.electron}, chromium: ${info.runtime.chromium}, node: ${info.runtime.node}`,
    `os: ${info.os.platform} ${info.os.release} ${info.os.arch}, locale: ${info.os.locale}`,
    `gpu: ${info.gpu}`,
    `native helpers: audio=${yesNo(info.nativeHelpers.audio)}, capture=${yesNo(info.nativeHelpers.capture)}, hotkeys=${yesNo(info.nativeHelpers.hotkeys)}`,
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
        channel: profile?.channel === 'dev' ? 'dev' : app.isPackaged ? 'release' : 'local',
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

  function copyInfo() {
    const { text } = getInfo();
    clipboard.writeText(text);
    return { ok: true };
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
        throw new Error('Desktop diagnostics are only available for the configured Voice Room URL.');
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
    setContext
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
  summarizeGpuStatus
};
