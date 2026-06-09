'use strict';

const { app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let activeSession = null;
let nextSessionId = 1;

app.on('before-quit', () => {
  stopSafeSystemAudioCapture();
});

function getNativeAudioCapabilities() {
  const helperPath = findSafeSystemAudioHelper();
  const nativeSafeLoopback = Boolean(helperPath);

  return {
    helperPath: helperPath || '',
    modes: {
      application: false,
      loopback: true,
      none: true,
      safeSystem: nativeSafeLoopback
    },
    nativeSafeLoopback,
    platform: process.platform,
    recommendedMode: nativeSafeLoopback ? 'safe-system' : 'loopback',
    requiresEchoFallbackWarning: !nativeSafeLoopback
  };
}

function hasNativeSafeLoopbackAudio() {
  return Boolean(findSafeSystemAudioHelper());
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

  if (!platformDir) return '';

  const candidates = [
    path.join(app.getAppPath(), 'native', 'bin', platformDir, executable),
    path.join(process.resourcesPath || '', 'native', 'bin', platformDir, executable),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'native', 'bin', platformDir, executable)
  ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function startSafeSystemAudioCapture(sender, options = {}) {
  const helperPath = findSafeSystemAudioHelper();
  if (!helperPath) {
    throw new Error('Native safe stream audio helper is not available in this build.');
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
    id: sessionId,
    sender,
    senderDestroyedListener: null
  };

  activeSession.senderDestroyedListener = () => {
    stopSafeSystemAudioCapture(sessionId);
  };
  sender.once('destroyed', activeSession.senderDestroyedListener);

  child.stdout.on('data', (chunk) => {
    if (!activeSession || activeSession.id !== sessionId || sender.isDestroyed()) return;
    sender.send('desktop-audio:data', {
      chunk,
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
      if (event.event === 'format') activeSession.format = event;
      if (!sender.isDestroyed()) {
        sender.send('desktop-audio:event', {
          event,
          sessionId
        });
      }
    }
  });

  child.on('error', (error) => {
    if (!sender.isDestroyed()) {
      sender.send('desktop-audio:event', {
        event: { event: 'error', message: error.message },
        sessionId
      });
    }
  });

  child.on('exit', (code, signal) => {
    if (!sender.isDestroyed()) {
      sender.send('desktop-audio:event', {
        event: { code, event: 'exit', signal },
        sessionId
      });
    }
    if (activeSession?.id === sessionId) activeSession = null;
  });

  return {
    args,
    helperPath,
    sessionId
  };
}

function getSafeSystemAudioHelperArgs(options = {}) {
  if (process.platform === 'darwin') return ['--safe-system'];

  if (process.platform === 'win32') {
    const targetPid = Number.isInteger(options.targetPid) && options.targetPid > 0
      ? options.targetPid
      : process.pid;
    const args = ['--target-pid', String(targetPid)];
    if (options.mode === 'application' && Number.isInteger(options.targetPid) && options.targetPid > 0) {
      args.push('--include-target');
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
  if (session.senderDestroyedListener && !session.sender.isDestroyed()) {
    session.sender.removeListener('destroyed', session.senderDestroyedListener);
  }
  session.child.kill();
  return true;
}

module.exports = {
  getNativeAudioCapabilities,
  hasNativeSafeLoopbackAudio,
  startSafeSystemAudioCapture,
  stopSafeSystemAudioCapture
};
