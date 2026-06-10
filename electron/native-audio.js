'use strict';

const { app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const log = require('./logger');
const EMPTY_AUDIO_BUFFER = Buffer.alloc(0);
let activeSession = null;
let nextSessionId = 1;

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

function startSafeSystemAudioCapture(sender, options = {}) {
  const helperLookup = findSafeSystemAudioHelper();
  const helperPath = helperLookup.path;
  if (!helperPath) {
    const error = new Error(`Native safe stream audio helper is not available in this build (${helperLookup.reason}).`);
    error.code = helperLookup.reason;
    throw error;
  }

  stopSafeSystemAudioCapture();

  const sessionId = String(nextSessionId++);
  const args = getSafeSystemAudioHelperArgs(options);
  const child = spawn(helperPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  activeSession = {
    child,
    format: null,
    frameBytes: 8,
    id: sessionId,
    leftover: Buffer.alloc(0),
    sender,
    senderDestroyedListener: null
  };

  activeSession.senderDestroyedListener = () => {
    stopSafeSystemAudioCapture(sessionId);
  };
  sender.once('destroyed', activeSession.senderDestroyedListener);

  child.stdout.on('data', (chunk) => {
    if (!activeSession || activeSession.id !== sessionId || sender.isDestroyed()) return;

    // stdout is split into chunks at arbitrary byte boundaries. Forward only whole audio frames
    // (channels * 4 bytes) and carry the partial tail to the next chunk. A frame split mid-sample
    // would shift every subsequent sample and turn playback into loud white noise.
    const frameBytes = activeSession.frameBytes || 8;
    const buffer = activeSession.leftover.length
      ? Buffer.concat([activeSession.leftover, chunk])
      : chunk;
    const alignedLength = buffer.length - (buffer.length % frameBytes);
    if (alignedLength <= 0) {
      activeSession.leftover = Buffer.from(buffer);
      return;
    }
    activeSession.leftover = alignedLength < buffer.length
      ? Buffer.from(buffer.subarray(alignedLength))
      : EMPTY_AUDIO_BUFFER;

    sender.send('desktop-audio:data', {
      chunk: buffer.subarray(0, alignedLength),
      sessionId
    });
  });

  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        event = { event: 'log', message: line };
      }
      if (event.event === 'format' && activeSession) {
        activeSession.format = event;
        const channels = Number(event.channels);
        if (Number.isFinite(channels) && channels > 0) {
          activeSession.frameBytes = channels * 4; // Float32 bytes per channel
        }
      }
      if (!sender.isDestroyed()) {
        sender.send('desktop-audio:event', {
          event,
          sessionId
        });
      }
    }
  });

  child.on('error', (error) => {
    log.error('Native audio helper process error:', error);
    if (!sender.isDestroyed()) {
      sender.send('desktop-audio:event', {
        event: { event: 'error', message: error.message },
        sessionId
      });
    }
  });

  child.on('exit', (code, signal) => {
    if (code !== 0) {
      log.warn('Native audio helper exited:', { code, signal, sessionId });
    }
    if (!sender.isDestroyed()) {
      sender.send('desktop-audio:event', {
        event: { code, event: 'exit', signal },
        sessionId
      });
    }
    if (activeSession?.id === sessionId) activeSession = null;
  });

  return {
    sessionId
  };
}

function getSafeSystemAudioHelperArgs(options = {}) {
  // Pass the main process PID so the macOS helper can exclude the entire Voice Room
  // process tree from the system-audio capture (mirrors Windows EXCLUDE_TARGET_PROCESS_TREE).
  if (process.platform === 'darwin') return ['--safe-system', '--exclude-pid', String(process.pid)];

  if (process.platform === 'win32') {
    const targetPid = Number.isInteger(options.targetPid) && options.targetPid > 0
      ? options.targetPid
      : process.pid;
    return ['--target-pid', String(targetPid)];
  }

  return [];
}

function stopSafeSystemAudioCapture(sessionId = '') {
  const session = activeSession;
  if (!session) return false;
  if (sessionId && session.id !== sessionId) return false;

  activeSession = null;
  if (session.senderDestroyedListener && !session.sender.isDestroyed()) {
    session.sender.removeListener('destroyed', session.senderDestroyedListener);
  }
  const child = session.child;
  if (child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 2000);
    forceKillTimer.unref?.();
  }
  return true;
}

module.exports = {
  getNativeAudioCapabilities,
  hasNativeSafeLoopbackAudio,
  startSafeSystemAudioCapture,
  stopSafeSystemAudioCapture
};
