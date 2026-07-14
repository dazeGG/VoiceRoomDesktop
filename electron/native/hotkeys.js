'use strict';

const { spawn: nodeSpawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOTKEY_ACTIONS = Object.freeze(['mic-mute', 'output-mute', 'push-to-talk']);
const HOTKEY_PHASES = new Set(['pressed', 'released']);
const STARTUP_TIMEOUT_MS = 3000;
const SHUTDOWN_GRACE_MS = 300;
const SHUTDOWN_FORCE_MS = 700;
const SHUTDOWN_CONFIRM_MS = 300;

function isHotkeyAction(value) {
  return typeof value === 'string' && HOTKEY_ACTIONS.includes(value);
}

function canExecute(candidate, platform = process.platform) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return platform === 'win32';
  }
}

function findNativeHotkeyHelper(options = {}) {
  const platform = options.platform || process.platform;
  const executable = platform === 'win32' ? 'VoiceRoomHotkeys.exe' : 'VoiceRoomHotkeys';
  const platformDir = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : '';
  if (!platformDir) return { candidates: [], path: '', reason: 'platform-unsupported' };

  const appPath = options.appPath || '';
  const resourcesPath = options.resourcesPath || '';
  const candidates = [
    path.join(resourcesPath, 'app.asar.unpacked', 'native', 'bin', platformDir, executable),
    path.join(resourcesPath, 'native', 'bin', platformDir, executable),
    path.join(appPath, 'native', 'bin', platformDir, executable)
  ];
  const checkedCandidates = candidates.map((candidate) => {
    const exists = fs.existsSync(candidate);
    const executableAccess = exists && canExecute(candidate, platform);
    return {
      executable: executableAccess,
      exists,
      path: candidate,
      skipped: candidate.includes('.asar' + path.sep) ? 'inside-asar' : ''
    };
  });
  const match = checkedCandidates.find((candidate) => candidate.exists && candidate.executable && !candidate.skipped);

  return {
    candidates: checkedCandidates,
    path: match?.path || '',
    reason: match
      ? ''
      : checkedCandidates.some((candidate) => candidate.exists && candidate.skipped)
        ? 'helper-inside-asar'
        : checkedCandidates.some((candidate) => candidate.exists && !candidate.executable)
          ? 'helper-not-executable'
          : 'helper-missing'
  };
}

function bindingToHelperArgument(action, binding) {
  if (!isHotkeyAction(action) || !binding || typeof binding !== 'object') return null;
  const code = typeof binding.code === 'string' && /^[A-Za-z0-9]{1,32}$/.test(binding.code)
    ? binding.code
    : '';
  if (!code) return null;

  let modifiers = '';
  if (binding.ctrlKey === true) modifiers += 'C';
  if (binding.altKey === true) modifiers += 'A';
  if (binding.shiftKey === true) modifiers += 'S';
  if (binding.metaKey === true) modifiers += 'M';
  return `${action}|${code}|${modifiers || '-'}`;
}

function normalizeReadyMessage(message, requestedActions) {
  const requested = new Set(requestedActions);
  const registered = Array.isArray(message?.registered)
    ? message.registered.filter((action) => isHotkeyAction(action) && requested.has(action))
    : [];
  const registeredSet = new Set(registered);
  const failed = Array.isArray(message?.failed)
    ? message.failed
      .filter((item) => item && requested.has(item.action) && !registeredSet.has(item.action))
      .map((item) => ({
        action: item.action,
        reason: typeof item.reason === 'string' && item.reason ? item.reason : 'registration-failed'
      }))
    : [];
  const accountedFor = new Set([...registered, ...failed.map((item) => item.action)]);
  for (const action of requestedActions) {
    if (!accountedFor.has(action)) failed.push({ action, reason: 'registration-failed' });
  }
  return { registered, failed };
}

function createNativeHotkeyBackend(options = {}) {
  const app = options.app;
  const log = options.log || console;
  const platform = options.platform || process.platform;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath ?? '';
  const spawn = options.spawn || nodeSpawn;
  const startupTimeoutMs = options.startupTimeoutMs || STARTUP_TIMEOUT_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  const shutdownForceMs = options.shutdownForceMs ?? SHUTDOWN_FORCE_MS;
  const shutdownConfirmMs = options.shutdownConfirmMs ?? SHUTDOWN_CONFIRM_MS;
  const unrefShutdownTimers = options.unrefShutdownTimers !== false;
  let session = null;
  let nextSessionId = 1;
  let operationGeneration = 0;
  let pendingShutdown = Promise.resolve(true);
  const pendingShutdownSessions = new Set();
  let suspended = false;

  function lookupHelper() {
    if (options.helperPath) {
      return { candidates: [], path: options.helperPath, reason: '' };
    }
    return findNativeHotkeyHelper({
      appPath: options.appPath || app?.getAppPath?.() || '',
      platform,
      resourcesPath
    });
  }

  function terminateSession(active) {
    if (active.shutdownPromise) return active.shutdownPromise;
    active.shutdownPromise = new Promise((resolve) => {
      const child = active.child;
      if (child.exitCode !== null || child.signalCode) {
        resolve(true);
        return;
      }

      let settled = false;
      let graceTimer = null;
      let forceTimer = null;
      let confirmationTimer = null;
      const finish = (confirmed = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        clearTimeout(forceTimer);
        clearTimeout(confirmationTimer);
        child.removeListener?.('exit', confirmExit);
        child.removeListener?.('close', confirmExit);
        resolve(confirmed);
      };
      const confirmExit = () => {
        active.exited = true;
        pendingShutdownSessions.delete(active);
        finish(true);
      };
      child.once?.('exit', confirmExit);
      child.once?.('close', confirmExit);

      try {
        // The helpers treat parent-pipe EOF as a graceful shutdown and emit any
        // still-active PTT release before exiting.
        child.stdin?.end?.();
      } catch (error) {
        log.warn?.('Native hotkey helper stdin shutdown failed:', error);
      }

      graceTimer = setTimeout(() => {
        if (settled) return;
        try {
          if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        } catch (error) {
          log.warn?.('Native hotkey helper termination failed:', error);
        }
        forceTimer = setTimeout(() => {
          if (settled) return;
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch (error) {
            log.warn?.('Native hotkey helper force termination failed:', error);
          }
          confirmationTimer = setTimeout(() => finish(false), shutdownConfirmMs);
          if (unrefShutdownTimers) confirmationTimer.unref?.();
        }, shutdownForceMs);
        if (unrefShutdownTimers) forceTimer.unref?.();
      }, shutdownGraceMs);
      if (unrefShutdownTimers) graceTimer.unref?.();
    });
    return active.shutdownPromise;
  }

  function childHasExited(active) {
    return Boolean(
      active.exited
      || active.child.exitCode !== null
      || active.child.signalCode
    );
  }

  function pendingShutdownsConfirmed() {
    for (const active of pendingShutdownSessions) {
      if (childHasExited(active)) pendingShutdownSessions.delete(active);
    }
    return pendingShutdownSessions.size === 0;
  }

  function waitForPendingShutdown() {
    const previousShutdown = pendingShutdown;
    pendingShutdown = previousShutdown.then(() => pendingShutdownsConfirmed());
    return pendingShutdown;
  }

  function releaseActivePushToTalk(active) {
    if (!active.pushToTalkPressed) return;
    active.pushToTalkPressed = false;
    try {
      active.onAction?.({ action: 'push-to-talk', phase: 'released' });
    } catch (error) {
      log.warn?.('Native hotkey PTT release delivery failed:', error);
    }
  }

  function queueTermination(active) {
    pendingShutdownSessions.add(active);
    const previousShutdown = pendingShutdown;
    const currentShutdown = terminateSession(active);
    pendingShutdown = Promise.all([previousShutdown, currentShutdown])
      .then(() => pendingShutdownsConfirmed());
    return pendingShutdown;
  }

  function stopActiveSession() {
    const active = session;
    if (!active) return waitForPendingShutdown();
    releaseActivePushToTalk(active);
    session = null;
    clearTimeout(active.startupTimer);
    active.intentionalStop = true;
    active.resolveReady?.({
      available: false,
      failed: active.requestedActions.map((action) => ({ action, reason: 'configuration-replaced' })),
      reason: 'configuration-replaced',
      registered: []
    });
    active.resolveReady = null;
    return queueTermination(active);
  }

  function stop() {
    operationGeneration += 1;
    return stopActiveSession();
  }

  function setSuspended(nextSuspended) {
    suspended = Boolean(nextSuspended);
  }

  async function start(bindings, handlers = {}) {
    const requestedEntries = Object.entries(bindings || {})
      .filter(([action, binding]) => isHotkeyAction(action) && binding)
      .map(([action, binding]) => ({ action, argument: bindingToHelperArgument(action, binding) }));
    const requestedActions = requestedEntries.map(({ action }) => action);
    const startGeneration = ++operationGeneration;
    const shutdownConfirmed = await stopActiveSession();
    if (startGeneration !== operationGeneration) {
      return {
        available: false,
        failed: requestedActions.map((action) => ({ action, reason: 'configuration-replaced' })),
        reason: 'configuration-replaced',
        registered: []
      };
    }
    if (!shutdownConfirmed) {
      return {
        available: false,
        failed: requestedActions.map((action) => ({ action, reason: 'helper-shutdown-timeout' })),
        reason: 'helper-shutdown-timeout',
        registered: []
      };
    }
    if (requestedEntries.length === 0) {
      return { available: true, failed: [], reason: '', registered: [] };
    }
    if (requestedEntries.some(({ argument }) => !argument)) {
      const failed = requestedEntries
        .filter(({ argument }) => !argument)
        .map(({ action }) => ({ action, reason: 'unsupported-key' }));
      const validBindings = Object.fromEntries(
        requestedEntries
          .filter(({ argument }) => argument)
          .map(({ action }) => [action, bindings[action]])
      );
      if (Object.keys(validBindings).length === 0) {
        return { available: true, failed, reason: '', registered: [] };
      }
      const validResult = await start(validBindings, handlers);
      return { ...validResult, failed: [...failed, ...validResult.failed] };
    }

    const helper = lookupHelper();
    if (!helper.path) {
      return {
        available: false,
        failed: requestedActions.map((action) => ({ action, reason: helper.reason })),
        reason: helper.reason,
        registered: []
      };
    }

    const args = requestedEntries.flatMap(({ argument }) => ['--binding', argument]);
    let child;
    try {
      child = spawn(helper.path, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      log.warn?.('Native hotkey helper failed to start:', error);
      return {
        available: false,
        failed: requestedActions.map((action) => ({ action, reason: 'helper-start-failed' })),
        reason: 'helper-start-failed',
        registered: []
      };
    }

    const id = nextSessionId++;
    const readyPromise = new Promise((resolve) => {
      session = {
        child,
        id,
        exited: false,
        intentionalStop: false,
        lineBuffer: '',
        ready: false,
        registered: new Set(),
        requestedActions,
        onAction: handlers.onAction,
        pushToTalkPressed: false,
        resolveReady: resolve,
        shutdownPromise: null,
        startupTimer: null
      };
    });
    const active = session;

    function finishBeforeReady(reason) {
      if (!session || session.id !== id || active.ready || !active.resolveReady) return;
      const resolve = active.resolveReady;
      active.resolveReady = null;
      clearTimeout(active.startupTimer);
      resolve({
        available: false,
        failed: requestedActions.map((action) => ({ action, reason })),
        reason,
        registered: []
      });
    }

    function handleMessage(message) {
      if (!session || session.id !== id || !message || typeof message !== 'object') return;
      if (message.event === 'ready' && !active.ready) {
        active.ready = true;
        clearTimeout(active.startupTimer);
        const normalized = normalizeReadyMessage(message, requestedActions);
        active.registered = new Set(normalized.registered);
        const resolve = active.resolveReady;
        active.resolveReady = null;
        resolve?.({ available: true, reason: '', ...normalized });
        if (normalized.registered.length === 0 && session?.id === id) {
          session = null;
          active.intentionalStop = true;
          void queueTermination(active);
        }
        return;
      }
      if (
        message.event === 'hotkey'
        && active.ready
        && active.registered.has(message.action)
        && HOTKEY_PHASES.has(message.phase)
      ) {
        if (message.action === 'push-to-talk') {
          active.pushToTalkPressed = message.phase === 'pressed';
        }
        if (!suspended) {
          handlers.onAction?.({ action: message.action, phase: message.phase });
        }
      }
    }

    child.stdout.on('data', (chunk) => {
      if (!session || session.id !== id) return;
      active.lineBuffer += String(chunk);
      if (active.lineBuffer.length > 64 * 1024) {
        log.warn?.('Native hotkey helper emitted an oversized line.');
        active.lineBuffer = '';
      }
      const lines = active.lineBuffer.split(/\r?\n/);
      active.lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          log.warn?.('Native hotkey helper emitted invalid JSON.');
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) log.warn?.('Native hotkey helper:', line.trim());
      }
    });

    child.on('error', (error) => {
      log.warn?.('Native hotkey helper process error:', error);
      if (!active.ready) {
        finishBeforeReady('helper-start-failed');
        if (session?.id === id) session = null;
        active.intentionalStop = true;
        void queueTermination(active);
      }
    });

    child.on('exit', (code, signal) => {
      active.exited = true;
      pendingShutdownSessions.delete(active);
      const stillActive = Boolean(session && session.id === id);
      const wasReady = active.ready;
      if (!active.ready) finishBeforeReady('helper-exited');
      if (!stillActive) return;
      releaseActivePushToTalk(active);
      session = null;
      clearTimeout(active.startupTimer);
      if (!active.intentionalStop && wasReady) {
        log.warn?.('Native hotkey helper exited:', { code, signal });
        handlers.onUnavailable?.({
          failed: [...active.registered].map((action) => ({ action, reason: 'helper-exited' })),
          registered: []
        });
      }
    });

    child.on('close', () => {
      active.exited = true;
      pendingShutdownSessions.delete(active);
    });

    active.startupTimer = setTimeout(() => {
      if (!session || session.id !== id || active.ready) return;
      finishBeforeReady('helper-timeout');
      session = null;
      active.intentionalStop = true;
      void queueTermination(active);
    }, startupTimeoutMs);
    active.startupTimer.unref?.();

    return readyPromise;
  }

  return {
    findHelper: lookupHelper,
    setSuspended,
    start,
    stop
  };
}

module.exports = {
  HOTKEY_ACTIONS,
  bindingToHelperArgument,
  createNativeHotkeyBackend,
  findNativeHotkeyHelper,
  normalizeReadyMessage
};
