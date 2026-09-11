'use strict';

const CHECK_INTERVAL_MS = 4 * 60 * 60_000;
// The startup gate lets the user in after a failed check; retry sooner then.
const RETRY_AFTER_FAILED_CHECK_MS = 15 * 60_000;
const RESUME_CHECK_DELAY_MS = 30_000;
const PENDING_UPDATE_CHECK_DELAY_MS = 5_000;
const DOWNLOAD_STALL_MS = 60 * 60_000;
const APPLY_POLL_MS = 60_000;
// A downloaded update installs by itself only after the window has stayed in the
// tray this long with no voice connection, so it never interrupts the user.
const APPLY_QUIET_MS = 10 * 60_000;

const UPDATER_EVENTS = Object.freeze([
  'update-available',
  'update-not-available',
  'update-downloaded',
  'error'
]);

function createBackgroundUpdateController({
  autoUpdater,
  log = console,
  isVoiceActive = () => false,
  isMainWindowVisible = () => false,
  onStateChange = () => {},
  beforeInstall = () => {},
  now = Date.now,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  checkIntervalMs = CHECK_INTERVAL_MS,
  applyQuietMs = APPLY_QUIET_MS
}) {
  let started = false;
  let disposed = false;
  let phase = 'idle';
  let readyVersion = '';
  let lastCheckAt = 0;
  let downloadStartedAt = 0;
  let checkTimer = null;
  let applyTimer = null;
  let quietSince = null;
  let installing = false;
  let powerMonitor = null;
  let onResume = null;
  const handlers = {};

  function getState() {
    return { phase, version: readyVersion };
  }

  function setPhase(nextPhase) {
    if (phase === nextPhase) return;
    phase = nextPhase;
    try {
      onStateChange(getState());
    } catch (error) {
      log.warn?.('Background update state listener failed:', error);
    }
  }

  function scheduleCheck(delayMs) {
    if (disposed) return;
    if (checkTimer) timers.clearTimeout(checkTimer);
    checkTimer = timers.setTimeout(() => {
      checkTimer = null;
      void checkNow();
    }, delayMs);
    checkTimer?.unref?.();
  }

  async function checkNow() {
    if (disposed || installing || phase === 'ready' || phase === 'checking') return;
    if (phase === 'downloading') {
      if (now() - downloadStartedAt < DOWNLOAD_STALL_MS) {
        scheduleCheck(checkIntervalMs);
        return;
      }
      log.warn?.('Background update download stalled; checking again.');
    }

    lastCheckAt = now();
    setPhase('checking');
    scheduleCheck(checkIntervalMs);
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      handlers.error(error);
    }
  }

  handlers['update-available'] = (info) => {
    if (disposed || phase === 'ready') return;
    downloadStartedAt = now();
    setPhase('downloading');
    log.info?.('Background update available, downloading:', info?.version || '');
    Promise.resolve()
      .then(() => autoUpdater.downloadUpdate())
      .catch((error) => handlers.error(error));
  };

  handlers['update-not-available'] = () => {
    if (phase !== 'ready') setPhase('idle');
  };

  handlers['update-downloaded'] = (info) => {
    if (disposed) return;
    readyVersion = typeof info?.version === 'string' ? info.version : '';
    log.info?.('Background update downloaded:', readyVersion);
    setPhase('ready');
    startApplyWatch();
  };

  handlers.error = (error) => {
    if (disposed) return;
    log.warn?.('Background update failed:', error?.message || error);
    if (phase === 'ready') return;
    setPhase('idle');
    scheduleCheck(RETRY_AFTER_FAILED_CHECK_MS);
  };

  function canInstallQuietly() {
    return !isVoiceActive() && !isMainWindowVisible();
  }

  function evaluateApply() {
    if (disposed || installing || phase !== 'ready') return;
    if (!canInstallQuietly()) {
      quietSince = null;
      return;
    }
    const current = now();
    if (quietSince === null) quietSince = current;
    if (current - quietSince >= applyQuietMs) {
      log.info?.('Installing background update while the app is idle in the tray.');
      installNow({ startHidden: true });
    }
  }

  function startApplyWatch() {
    if (applyTimer || disposed) return;
    quietSince = null;
    evaluateApply();
    applyTimer = timers.setInterval(evaluateApply, APPLY_POLL_MS);
    applyTimer?.unref?.();
  }

  function installNow({ startHidden = !isMainWindowVisible() } = {}) {
    if (disposed || installing || phase !== 'ready') return false;
    installing = true;
    try {
      beforeInstall({ startHidden });
    } catch (error) {
      log.warn?.('Background update pre-install hook failed:', error);
    }
    // Silent installer, relaunch the app once it finishes.
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  // `updatePending`: a silent startup gate saw an update and left the download
  // to this controller. `lastCheckFailed`: the startup check did not complete.
  function start({ lastCheckFailed = false, updatePending = false } = {}) {
    if (started || disposed) return;
    started = true;
    // Downloaded-but-not-applied updates install when the user quits for real.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    for (const eventName of UPDATER_EVENTS) {
      autoUpdater.on(eventName, handlers[eventName]);
    }
    lastCheckAt = now();
    if (updatePending) scheduleCheck(PENDING_UPDATE_CHECK_DELAY_MS);
    else scheduleCheck(lastCheckFailed ? RETRY_AFTER_FAILED_CHECK_MS : checkIntervalMs);
  }

  // Timers do not advance reliably across system sleep; check on wake when the
  // regular interval has already elapsed.
  function installPowerMonitor(nextPowerMonitor) {
    if (powerMonitor || !nextPowerMonitor?.on) return;
    powerMonitor = nextPowerMonitor;
    onResume = () => {
      if (started && now() - lastCheckAt >= checkIntervalMs) scheduleCheck(RESUME_CHECK_DELAY_MS);
    };
    powerMonitor.on('resume', onResume);
  }

  function dispose() {
    disposed = true;
    if (checkTimer) timers.clearTimeout(checkTimer);
    if (applyTimer) timers.clearInterval(applyTimer);
    checkTimer = null;
    applyTimer = null;
    if (started) {
      for (const eventName of UPDATER_EVENTS) {
        autoUpdater.removeListener(eventName, handlers[eventName]);
      }
    }
    if (powerMonitor && onResume) powerMonitor.removeListener?.('resume', onResume);
    powerMonitor = null;
    onResume = null;
  }

  return {
    checkNow,
    dispose,
    evaluateApply,
    getState,
    installNow,
    installPowerMonitor,
    start
  };
}

module.exports = {
  APPLY_POLL_MS,
  APPLY_QUIET_MS,
  CHECK_INTERVAL_MS,
  DOWNLOAD_STALL_MS,
  PENDING_UPDATE_CHECK_DELAY_MS,
  RESUME_CHECK_DELAY_MS,
  RETRY_AFTER_FAILED_CHECK_MS,
  createBackgroundUpdateController
};
