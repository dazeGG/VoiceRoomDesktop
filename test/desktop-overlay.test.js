'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createCallControlsController } = require('../electron/call-controls');
const { createOverlayController, STATE_CHANNEL } = require('../electron/overlay');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.url = 'file:///overlay.html';
  }

  getURL() { return this.url; }
  send(channel, payload) { this.sent.push([channel, payload]); }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.bounds = { height: options.height, width: options.width, x: 0, y: 0 };
    this.destroyed = false;
    this.focused = false;
    this.visible = false;
    this.ignoreMouse = [];
    this.alwaysOnTop = [];
    this.webContents = new FakeWebContents();
    this.loaded = null;
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  showInactive() { this.visible = true; }
  show() { this.visible = true; this.focused = true; }
  hide() { this.visible = false; this.focused = false; }
  focus() { this.focused = true; }
  close() { this.emit('close', { preventDefault() {} }); this.destroy(); }
  destroy() {
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  setContentSize(width, height) {
    this.bounds = { ...this.bounds, width, height };
  }
  setAlwaysOnTop(flag, level, relativeLevel) {
    this.alwaysOnTop.push([flag, level, relativeLevel]);
  }
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents(ignore, options) { this.ignoreMouse.push([ignore, options]); }
  setFocusable(focusable) { this.focusable = focusable; }
  setMenuBarVisibility() {}
  loadFile(filePath) {
    this.loaded = filePath;
    return Promise.resolve();
  }
}

class FakeSender extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.sent = [];
  }

  isDestroyed() { return this.destroyed; }
  send(channel, payload) { this.sent.push([channel, payload]); }
}

class FakeMainWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.focused = true;
    this.visible = true;
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  blur() {
    this.focused = false;
    this.emit('blur');
  }
  hide() {
    this.visible = false;
    this.focused = false;
    this.emit('hide');
  }
}

function createHarness(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-overlay-'));
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }));
  const windows = [];
  const shortcuts = new Map();
  const callControls = createCallControlsController({ log: { warn() {} } });
  const controller = createOverlayController({
    BrowserWindow: function BrowserWindow(options) {
      const window = new FakeWindow(options);
      windows.push(window);
      return window;
    },
    app: { getPath: () => userDataPath },
    callControls,
    createForegroundWatcher: () => ({ start() {}, stop() {} }),
    fs,
    globalShortcut: {
      register(accelerator, callback) {
        shortcuts.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) { shortcuts.delete(accelerator); }
    },
    log: { warn() {} },
    path,
    platform: 'win32',
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayMatching: () => ({ scaleFactor: 1, workArea: { height: 1080, width: 1920, x: 0, y: 0 } }),
      getDisplayNearestPoint: () => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }),
      getPrimaryDisplay: () => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } })
    }
  });
  t.after(() => controller.dispose());
  return { callControls, controller, shortcuts, windows };
}

const CS2 = {
  bounds: { height: 1080, width: 1920, x: 0, y: 0 },
  exe: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
  pid: 4242,
  title: 'Counter-Strike 2'
};

describe('desktop overlay controller', () => {
  it('stays hidden until a game is in the foreground during a call', (t) => {
    const { callControls, controller, windows } = createHarness(t);
    const main = new FakeMainWindow();
    controller.attachMainWindow(main);
    callControls.setState(new FakeSender(), {
      active: true,
      roomId: 'abc123',
      roomName: 'Гостиная'
    });
    assert.equal(windows.length, 0);

    main.blur();
    assert.equal(windows.length, 0);

    controller.handleForeground({
      bounds: { height: 1080, width: 1920, x: 0, y: 0 },
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      pid: 7,
      title: 'Gmail'
    });
    assert.equal(windows.length, 0);

    controller.handleForeground(CS2);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, true);
    assert.equal(windows[0].ignoreMouse.at(-1)[0], true);
    assert.equal(windows[0].alwaysOnTop.at(-1)[1], 'screen-saver');
    assert.deepEqual(windows[0].bounds, { height: 132, width: 280, x: 16, y: 16 });
    assert.match(windows[0].loaded.replace(/\\/g, '/'), /ui\/overlay.html$/);
  });

  it('passes overlay actions through to call controls', (t) => {
    const { callControls, controller, windows } = createHarness(t);
    const main = new FakeMainWindow();
    controller.attachMainWindow(main);
    const sender = new FakeSender();
    callControls.setState(sender, { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    controller.handleForeground(CS2);
    assert.equal(windows.length, 1);
    assert.equal(callControls.dispatch('toggle-mic'), true);
    assert.deepEqual(sender.sent.at(-1)[1], { action: 'toggle-mic' });
  });

  it('toggles click-through with the overlay hotkey', (t) => {
    const { callControls, controller, shortcuts, windows } = createHarness(t);
    const main = new FakeMainWindow();
    controller.attachMainWindow(main);
    callControls.setState(new FakeSender(), { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    controller.handleForeground(CS2);
    const overlay = windows[0];
    assert.ok(shortcuts.has('Control+`'));
    shortcuts.get('Control+`')();
    assert.equal(overlay.ignoreMouse.at(-1)[0], false);
    const state = overlay.webContents.sent.filter(([channel]) => channel === STATE_CHANNEL).at(-1)[1];
    assert.equal(state.interactive, true);
    assert.match(state.hint, /Ctrl\+`/);
  });

  it('keeps overlay settings when autostart later writes startMinimized', (t) => {
    const { controller } = createHarness(t);
    const settings = controller.setSettings({ enabled: false, anchor: 'bottom-right' });
    assert.equal(settings.enabled, false);
    assert.equal(settings.anchor, 'bottom-right');
    assert.equal(controller.getSettings().showParticipants, true);
  });

  it('lets the user allowlist a custom executable as a game', (t) => {
    const { callControls, controller, windows } = createHarness(t);
    controller.attachMainWindow(new FakeMainWindow());
    callControls.setState(new FakeSender(), { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    const custom = {
      bounds: { height: 1080, width: 1920, x: 0, y: 0 },
      exe: 'D:\\Games\\MyGame\\mygame.exe',
      pid: 9,
      title: 'My Game'
    };
    controller.handleForeground(custom);
    assert.equal(windows.length, 0);
    controller.setSettings({ allowedExecutables: ['mygame.exe'] });
    controller.handleForeground(custom);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, true);
  });
});
