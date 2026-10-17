'use strict';

const { app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const log = require('../logger');
const { createRestartPolicy } = require('../policies/native-capture-restart');
const EMPTY_AUDIO_BUFFER = Buffer.alloc(0);
let activeSession = null;
let nextSessionId = 1;
// Last outcome, kept after the session ends for diagnostics.
let lastSessionSummary = null;

app.on('before-quit', () => {
  stopSafeSystemAudioCapture();
});

function getNativeAudioCapabilities() {
  const helperLookup = findSafeSystemAudioHelper();
  const helperPath = helperLookup.path;
  const nativeSafeLoopback = Boolean(helperPath);

  return {
    modes: {
      loopback: true,
      none: true,
      safeSystem: nativeSafeLoopback
    },
    nativeSafeLoopback,
    platform: process.platform,
    recommendedMode: nativeSafeLoopback ? 'safe-system' : 'loopback',
    reason: nativeSafeLoopback ? '' : helperLookup.reason,
    requiresEchoFallbackWarning: !nativeSafeLoopback
  };
}

function hasNativeSafeLoopbackAudio() {
  return Boolean(findSafeSystemAudioHelper().path);
}

function findSafeSystemAudioHelper() {
  const executable = process.platform === 'win32'
    ? 'SafeSystemAudioCapture.exe'
    : 'SafeSystemAudioCapture';
  const platformDir = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : '';

  if (!platformDir) {
    return {
      candidates: [],
      path: '',
      reason: 'platform-unsupported'
    };
  }

  const appPath = app.getAppPath();
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'native', 'bin', platformDir, executable),
    path.join(process.resourcesPath || '', 'native', 'bin', platformDir, executable),
    path.join(appPath, 'native', 'bin', platformDir, executable)
  ];

  const checkedCandidates = candidates.map((candidate) => {
    const exists = fs.existsSync(candidate);
    const executableAccess = exists && canExecute(candidate);
    return {
      executable: executableAccess,
      exists,
      path: candidate,
      skipped: candidate.includes('.asar' + path.sep)
        ? 'inside-asar'
        : ''
    };
  });

  const match = checkedCandidates.find((candidate) => candidate.exists && candidate.executable && !candidate.skipped);
  return {
    candidates: checkedCandidates,
    path: match?.path || '',
    reason: checkedCandidates.some((candidate) => candidate.exists && candidate.skipped)
      ? 'helper-inside-asar'
      : checkedCandidates.some((candidate) => candidate.exists && !candidate.executable)
        ? 'helper-not-executable'
        : 'helper-missing'
  };
}

function canExecute(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return process.platform === 'win32';
  }
}

function sendEvent(session, event) {
  if (session.sender.isDestroyed()) return;
  session.sender.send('desktop-audio:event', {
    event,
    sessionId: session.id
  });
}

// The helper can die mid-stream (audio service restart, a broken capture client).
// It is restarted under the same session id with the same fixed format, so the
// page keeps one audio track and only hears a short gap.
function startSafeSystemAudioCapture(sender, options = {}) {
  const helperLookup = findSafeSystemAudioHelper();
  const helperPath = helperLookup.path;
  if (!helperPath) {
    const error = new Error(`Native safe stream audio helper is not available in this build (${helperLookup.reason}).`);
    error.code = helperLookup.reason;
    throw error;
  }

  stopSafeSystemAudioCapture();

  const session = {
    args: getSafeSystemAudioHelperArgs(options),
    child: null,
    format: null,
    frameBytes: 8,
    helperPath,
    id: String(nextSessionId++),
    lastExit: null,
    leftover: EMPTY_AUDIO_BUFFER,
    restartPolicy: createRestartPolicy(),
    restartTimer: null,
    restarts: 0,
    sender,
    senderDestroyedListener: null,
    stopped: false,
    target: options.targetWindow ? 'app' : 'system'
  };
  activeSession = session;

  session.senderDestroyedListener = () => {
    stopSafeSystemAudioCapture(session.id);
  };
  sender.once('destroyed', session.senderDestroyedListener);

  spawnHelper(session);
  return {
    sessionId: session.id
  };
}

function spawnHelper(session) {
  const child = spawn(session.helperPath, session.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  session.child = child;
  session.leftover = EMPTY_AUDIO_BUFFER;
  const current = () => activeSession === session && session.child === child && !session.stopped;

  child.stdout.on('data', (chunk) => {
    if (!current() || session.sender.isDestroyed()) return;
    session.restartPolicy.noteHealthy();

    // stdout is split into chunks at arbitrary byte boundaries. Forward only whole audio frames
    // (channels * 4 bytes) and carry the partial tail to the next chunk. A frame split mid-sample
    // would shift every subsequent sample and turn playback into loud white noise.
    const frameBytes = session.frameBytes || 8;
    const buffer = session.leftover.length
      ? Buffer.concat([session.leftover, chunk])
      : chunk;
    const alignedLength = buffer.length - (buffer.length % frameBytes);
    if (alignedLength <= 0) {
      session.leftover = Buffer.from(buffer);
      return;
    }
    session.leftover = alignedLength < buffer.length
      ? Buffer.from(buffer.subarray(alignedLength))
      : EMPTY_AUDIO_BUFFER;

    session.sender.send('desktop-audio:data', {
      chunk: buffer.subarray(0, alignedLength),
      sessionId: session.id
    });
  });

  child.stderr.on('data', (chunk) => {
    if (!current()) return;
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        event = { event: 'log', message: line };
      }
      if (event.event === 'format') {
        session.format = event;
        const channels = Number(event.channels);
        if (Number.isFinite(channels) && channels > 0) {
          session.frameBytes = channels * 4; // Float32 bytes per channel
        }
      } else if (event.event === 'error' || event.event === 'warning') {
        log.warn('Native audio helper:', event.message || event.event);
      }
      sendEvent(session, event);
    }
  });

  child.on('error', (error) => {
    if (session.child !== child) return;
    log.error('Native audio helper process error:', error);
    sendEvent(session, { event: 'error', message: error.message });
  });

  child.on('exit', (code, signal) => {
    if (session.child !== child) return;
    session.lastExit = { code, signal };
    const delay = current() ? session.restartPolicy.nextRestartDelay(code) : null;
    if (delay !== null) {
      log.warn('Native audio helper stopped; restarting.', {
        attempt: session.restarts + 1,
        code,
        delayMs: delay,
        sessionId: session.id,
        signal
      });
      sendEvent(session, { attempt: session.restarts + 1, delayMs: delay, event: 'restarting' });
      session.restartTimer = setTimeout(() => {
        session.restartTimer = null;
        if (activeSession !== session || session.stopped) return;
        session.restarts += 1;
        try {
          spawnHelper(session);
        } catch (error) {
          log.error('Native audio helper restart failed:', error);
          finishSession(session, { code, signal });
        }
      }, delay);
      session.restartTimer.unref?.();
      return;
    }

    if (code !== 0 && !session.stopped) {
      log.warn('Native audio helper exited:', { code, signal, sessionId: session.id });
    }
    finishSession(session, { code, signal });
  });
}

function finishSession(session, { code, signal }) {
  sendEvent(session, { code, event: 'exit', signal });
  rememberSession(session);
  if (activeSession === session) activeSession = null;
}

function rememberSession(session) {
  lastSessionSummary = {
    lastExitCode: session.lastExit?.code ?? null,
    restarts: session.restarts,
    target: session.target
  };
}

function getSafeSystemAudioHelperArgs(options = {}) {
  // Pass the main process PID so the macOS helper can exclude the entire VoiceRoom
  // process tree from the system-audio capture (mirrors Windows EXCLUDE_TARGET_PROCESS_TREE).
  if (process.platform === 'darwin') return ['--safe-system', '--exclude-pid', String(process.pid)];

  if (process.platform === 'win32') {
    const targetPid = Number.isInteger(options.targetPid) && options.targetPid > 0
      ? options.targetPid
      : process.pid;
    const args = ['--target-pid', String(targetPid)];
    // Only the app behind this window; the helper falls back to targetPid's
    // exclusion when the window is already gone.
    if (Number.isSafeInteger(options.targetWindow) && options.targetWindow > 0) {
      args.push('--target-window', String(options.targetWindow));
    }
    return args;
  }

  return [];
}

function stopSafeSystemAudioCapture(sessionId = '') {
  const session = activeSession;
  if (!session) return false;
  if (sessionId && session.id !== sessionId) return false;

  activeSession = null;
  session.stopped = true;
  rememberSession(session);
  if (session.restartTimer) {
    clearTimeout(session.restartTimer);
    session.restartTimer = null;
  }
  if (session.senderDestroyedListener && !session.sender.isDestroyed()) {
    session.sender.removeListener('destroyed', session.senderDestroyedListener);
  }
  const child = session.child;
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 2000);
    forceKillTimer.unref?.();
  }
  return true;
}

function getNativeAudioState() {
  const session = activeSession;
  if (session) {
    return {
      active: true,
      restarts: session.restarts,
      restarting: Boolean(session.restartTimer),
      target: session.target
    };
  }
  return { active: false, ...(lastSessionSummary || {}) };
}

module.exports = {
  getNativeAudioCapabilities,
  getNativeAudioState,
  getSafeSystemAudioHelperArgs,
  hasNativeSafeLoopbackAudio,
  startSafeSystemAudioCapture,
  stopSafeSystemAudioCapture
};
