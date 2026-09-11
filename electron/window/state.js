'use strict';

const WINDOW_STATE_FILE = 'window-state.json';
const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1180, height: 820 });
const MIN_WINDOW_SIZE = Object.freeze({ width: 420, height: 620 });
// A window counts as reachable only when enough of it (roughly its title bar)
// overlaps a display the user can still see.
const MIN_VISIBLE_OVERLAP = Object.freeze({ width: 120, height: 48 });
const SAVE_DEBOUNCE_MS = 500;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(isFiniteNumber) || width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function normalizeStoredWindowState(value) {
  const bounds = normalizeRect(value?.bounds);
  if (!bounds) return null;
  return { bounds, isMaximized: value.isMaximized === true };
}

function overlap(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? { width, height } : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function fitSize(size, workArea, minimum) {
  return {
    width: clamp(size.width, Math.min(minimum.width, workArea.width), workArea.width),
    height: clamp(size.height, Math.min(minimum.height, workArea.height), workArea.height)
  };
}

function centerIn(size, workArea) {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    ...size
  };
}

/**
 * Resolves the rectangle for a new main window from the saved state and the
 * displays that exist right now. Visible windows keep their place (pulled fully
 * into their display), unreachable ones are centered on the primary display.
 */
function resolveWindowBounds({
  saved,
  displays = [],
  primaryDisplay,
  defaults = DEFAULT_WINDOW_SIZE,
  minimum = MIN_WINDOW_SIZE
} = {}) {
  const workAreas = displays.map((display) => normalizeRect(display?.workArea)).filter(Boolean);
  const primaryWorkArea = normalizeRect(primaryDisplay?.workArea) || workAreas[0] || null;
  const state = normalizeStoredWindowState(saved);

  if (!primaryWorkArea) {
    return { bounds: state?.bounds || { ...defaults }, isMaximized: state?.isMaximized === true };
  }

  if (!state) {
    return { bounds: centerIn(fitSize(defaults, primaryWorkArea, minimum), primaryWorkArea), isMaximized: false };
  }

  const candidate = {
    ...state.bounds,
    width: Math.max(state.bounds.width, minimum.width),
    height: Math.max(state.bounds.height, minimum.height)
  };
  let bestWorkArea = null;
  let bestArea = 0;
  for (const workArea of workAreas) {
    const shared = overlap(candidate, workArea);
    if (!shared || shared.width < MIN_VISIBLE_OVERLAP.width || shared.height < MIN_VISIBLE_OVERLAP.height) continue;
    const area = shared.width * shared.height;
    if (area > bestArea) {
      bestArea = area;
      bestWorkArea = workArea;
    }
  }

  if (!bestWorkArea) {
    return {
      bounds: centerIn(fitSize(state.bounds, primaryWorkArea, minimum), primaryWorkArea),
      isMaximized: state.isMaximized
    };
  }

  const size = fitSize(state.bounds, bestWorkArea, minimum);
  return {
    bounds: {
      x: clamp(state.bounds.x, bestWorkArea.x, bestWorkArea.x + bestWorkArea.width - size.width),
      y: clamp(state.bounds.y, bestWorkArea.y, bestWorkArea.y + bestWorkArea.height - size.height),
      ...size
    },
    isMaximized: state.isMaximized
  };
}

function createWindowStateController({
  app,
  fs,
  path,
  screen,
  log = console,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout
}) {
  function stateFilePath() {
    return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
  }

  function readSavedState() {
    try {
      return normalizeStoredWindowState(JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')));
    } catch {
      return null;
    }
  }

  function writeSavedState(state) {
    const filePath = stateFilePath();
    const tempPath = `${filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(state));
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      log.warn?.('Failed to save window state:', error);
    }
  }

  // Recorded for troubleshooting multi-monitor setups; restoring works from
  // the live display list and does not depend on it.
  function matchDisplay(bounds) {
    try {
      const display = screen.getDisplayMatching?.(bounds);
      const displayBounds = normalizeRect(display?.bounds);
      return display && displayBounds ? { bounds: displayBounds, id: display.id } : null;
    } catch {
      return null;
    }
  }

  function resolveInitialState() {
    try {
      return resolveWindowBounds({
        saved: readSavedState(),
        displays: screen.getAllDisplays(),
        primaryDisplay: screen.getPrimaryDisplay()
      });
    } catch (error) {
      log.warn?.('Failed to resolve window state:', error);
      return { bounds: { ...DEFAULT_WINDOW_SIZE }, isMaximized: false };
    }
  }

  function track(window, { isMaximized = false } = {}) {
    let saveTimer = null;
    // Fullscreen is never restored, so a window that went fullscreen keeps the
    // maximized flag it had before. A window hidden in the tray reports itself
    // as not maximized, so keep the flag from when it was last visible.
    let lastMaximized = isMaximized === true;

    function capture() {
      if (window.isDestroyed() || window.isMinimized()) return null;
      if (window.isVisible() && !window.isFullScreen()) lastMaximized = window.isMaximized();
      const bounds = normalizeRect(window.getNormalBounds());
      if (!bounds) return null;
      const state = { bounds, isMaximized: lastMaximized };
      const display = matchDisplay(bounds);
      if (display) state.display = display;
      return state;
    }

    function saveNow() {
      if (saveTimer) cancel(saveTimer);
      saveTimer = null;
      const state = capture();
      if (state) writeSavedState(state);
    }

    function scheduleSave() {
      if (saveTimer) cancel(saveTimer);
      saveTimer = schedule(saveNow, SAVE_DEBOUNCE_MS);
    }

    for (const eventName of ['move', 'resize']) window.on(eventName, scheduleSave);
    for (const eventName of ['maximize', 'unmaximize', 'close', 'hide']) window.on(eventName, saveNow);
    window.once('closed', () => {
      if (saveTimer) cancel(saveTimer);
      saveTimer = null;
    });
  }

  return {
    resolveInitialState,
    track
  };
}

module.exports = {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  SAVE_DEBOUNCE_MS,
  WINDOW_STATE_FILE,
  createWindowStateController,
  resolveWindowBounds
};
