'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  SAVE_DEBOUNCE_MS,
  WINDOW_STATE_FILE,
  createWindowStateController,
  resolveWindowBounds
} = require('../electron/window/state');

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { workArea: { x: 1920, y: 0, width: 1280, height: 984 } };

describe('resolveWindowBounds', () => {
  it('centers the default size on the primary display without saved state', () => {
    assert.deepEqual(resolveWindowBounds({ saved: null, displays: [primary], primaryDisplay: primary }), {
      bounds: { x: 370, y: 110, width: 1180, height: 820 },
      isMaximized: false
    });
  });

  it('keeps a fully visible saved window and its maximized flag', () => {
    const saved = { bounds: { x: 2000, y: 40, width: 900, height: 700 }, isMaximized: true };
    assert.deepEqual(resolveWindowBounds({ saved, displays: [primary, secondary], primaryDisplay: primary }), saved);
  });

  it('pulls a partially visible window fully into the display it mostly sits on', () => {
    const saved = { bounds: { x: 1500, y: 700, width: 1000, height: 640 }, isMaximized: false };
    assert.deepEqual(resolveWindowBounds({ saved, displays: [primary], primaryDisplay: primary }), {
      bounds: { x: 920, y: 400, width: 1000, height: 640 },
      isMaximized: false
    });
  });

  it('centers the saved size on the primary display when its monitor is gone', () => {
    const saved = { bounds: { x: 2100, y: 100, width: 1000, height: 700 }, isMaximized: true };
    assert.deepEqual(resolveWindowBounds({ saved, displays: [primary], primaryDisplay: primary }), {
      bounds: { x: 460, y: 170, width: 1000, height: 700 },
      isMaximized: true
    });
  });

  it('treats a sliver of overlap as unreachable', () => {
    const saved = { bounds: { x: 1880, y: 100, width: 800, height: 640 }, isMaximized: false };
    const resolved = resolveWindowBounds({ saved, displays: [primary], primaryDisplay: primary });
    assert.deepEqual(resolved.bounds, { x: 560, y: 200, width: 800, height: 640 });
  });

  it('shrinks a window larger than the work area without going below the minimum size', () => {
    const small = { workArea: { x: 0, y: 0, width: 1280, height: 680 } };
    const saved = { bounds: { x: 0, y: 0, width: 2400, height: 1500 }, isMaximized: false };
    assert.deepEqual(resolveWindowBounds({ saved, displays: [small], primaryDisplay: small }).bounds, {
      x: 0, y: 0, width: 1280, height: 680
    });

    const tiny = { bounds: { x: 10, y: 10, width: 100, height: 100 }, isMaximized: false };
    assert.deepEqual(resolveWindowBounds({ saved: tiny, displays: [primary], primaryDisplay: primary }).bounds, {
      x: 10, y: 10, width: 420, height: 620
    });
  });

  it('ignores corrupt saved state', () => {
    for (const saved of [{}, { bounds: { x: 'a', y: 0, width: 10, height: 10 } }, { bounds: { x: 0, y: 0, width: -1, height: 5 } }, 'nope']) {
      assert.deepEqual(resolveWindowBounds({ saved, displays: [primary], primaryDisplay: primary }), {
        bounds: { x: 370, y: 110, width: 1180, height: 820 },
        isMaximized: false
      });
    }
  });
});

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.fullScreen = false;
    this.maximized = false;
    this.minimized = false;
    this.normalBounds = { x: 100, y: 100, width: 1000, height: 700 };
    this.visible = true;
  }

  getNormalBounds() { return this.normalBounds; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  isFullScreen() { return this.fullScreen; }
  isMaximized() { return this.maximized; }
  isMinimized() { return this.minimized; }
}

function createHarness({ fileContent, getDisplayMatching } = {}) {
  const files = new Map();
  const userData = path.join('C:', 'data');
  const filePath = path.join(userData, WINDOW_STATE_FILE);
  if (fileContent !== undefined) files.set(filePath, fileContent);
  const timers = [];
  const fs = {
    mkdirSync() {},
    readFileSync(target) {
      if (!files.has(target)) throw new Error('ENOENT');
      return files.get(target);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    writeFileSync(target, content) { files.set(target, content); }
  };
  const controller = createWindowStateController({
    app: { getPath: () => userData },
    fs,
    log: { warn() {} },
    path,
    screen: {
      getAllDisplays: () => [primary],
      getPrimaryDisplay: () => primary,
      ...(getDisplayMatching ? { getDisplayMatching } : {})
    },
    clearTimeout: (timer) => { timer.cancelled = true; },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    }
  });
  return {
    controller,
    flushTimers: () => timers.filter((timer) => !timer.cancelled).forEach((timer) => { timer.cancelled = true; timer.callback(); }),
    read: () => (files.has(filePath) ? JSON.parse(files.get(filePath)) : null),
    timers
  };
}

describe('window state controller', () => {
  it('resolves the initial state from the saved file', () => {
    const saved = { bounds: { x: 50, y: 60, width: 900, height: 700 }, isMaximized: true };
    const harness = createHarness({ fileContent: JSON.stringify(saved) });
    assert.deepEqual(harness.controller.resolveInitialState(), saved);
    assert.deepEqual(createHarness({ fileContent: '{broken' }).controller.resolveInitialState().bounds, {
      x: 370, y: 110, width: 1180, height: 820
    });
  });

  it('debounces move and resize writes', () => {
    const harness = createHarness();
    const window = new FakeWindow();
    harness.controller.track(window);

    window.emit('move');
    window.emit('resize');
    assert.equal(harness.read(), null);
    assert.equal(harness.timers.at(-1).delay, SAVE_DEBOUNCE_MS);

    harness.flushTimers();
    assert.deepEqual(harness.read(), { bounds: window.normalBounds, isMaximized: false });
  });

  it('writes immediately on maximize, hide to tray and close', () => {
    const harness = createHarness();
    const window = new FakeWindow();
    harness.controller.track(window);

    window.maximized = true;
    window.emit('maximize');
    assert.deepEqual(harness.read(), { bounds: window.normalBounds, isMaximized: true });

    window.normalBounds = { x: 1, y: 2, width: 800, height: 640 };
    window.emit('hide');
    assert.deepEqual(harness.read().bounds, { x: 1, y: 2, width: 800, height: 640 });

    window.maximized = false;
    window.emit('close');
    assert.equal(harness.read().isMaximized, false);
  });

  it('records the display the window sits on', () => {
    const harness = createHarness({
      getDisplayMatching: () => ({ bounds: { x: 1920, y: 0, width: 2752, height: 1152 }, id: 2528732444, scaleFactor: 1.25 })
    });
    const window = new FakeWindow();
    harness.controller.track(window);
    window.emit('close');

    assert.deepEqual(harness.read(), {
      bounds: window.normalBounds,
      display: { bounds: { x: 1920, y: 0, width: 2752, height: 1152 }, id: 2528732444, scaleFactor: 1.25 },
      isMaximized: false
    });
  });

  it('applies restored bounds twice so the size is converted with the target monitor scale', () => {
    const harness = createHarness();
    const bounds = { x: 2100, y: 120, width: 1000, height: 700 };
    const placedWindow = (placed) => {
      const applied = [];
      return { applied, getBounds: () => placed, setBounds: (next) => applied.push(next) };
    };

    const exact = placedWindow(bounds);
    harness.controller.applyBounds(exact, bounds);
    assert.deepEqual(exact.applied, [bounds, bounds]);

    // Measured on a 125% monitor: 1000x776 came back as 1003x778.
    const rounded = placedWindow({ ...bounds, width: 1003, height: 702 });
    harness.controller.applyBounds(rounded, bounds);
    assert.deepEqual(rounded.applied, [bounds, bounds, { ...bounds, width: 997, height: 698 }]);

    const clamped = placedWindow({ ...bounds, width: 1400, height: 700 });
    harness.controller.applyBounds(clamped, bounds);
    assert.deepEqual(clamped.applied, [bounds, bounds], 'a real size constraint is not rounding drift');

    assert.doesNotThrow(() => harness.controller.applyBounds({ setBounds: () => { throw new Error('destroyed'); } }, { x: 0, y: 0, width: 10, height: 10 }));
  });

  it('never persists fullscreen or minimized geometry', () => {
    const harness = createHarness();
    const window = new FakeWindow();
    harness.controller.track(window);

    window.maximized = true;
    window.emit('maximize');
    window.fullScreen = true;
    window.maximized = false;
    window.emit('close');
    assert.equal(harness.read().isMaximized, true);

    const hiddenHarness = createHarness();
    const hidden = new FakeWindow();
    hiddenHarness.controller.track(hidden, { isMaximized: true });
    hidden.visible = false;
    hidden.emit('close');
    assert.equal(hiddenHarness.read().isMaximized, true, 'a hidden launch keeps the restored maximized flag');

    const minimizedHarness = createHarness();
    const minimized = new FakeWindow();
    minimizedHarness.controller.track(minimized);
    minimized.minimized = true;
    minimized.emit('close');
    assert.equal(minimizedHarness.read(), null);
  });
});
