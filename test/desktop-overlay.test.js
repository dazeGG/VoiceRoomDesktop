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

const VOICE_ROOM_PID = 1;

function createHarness(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-overlay-'));
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }));
  const windows = [];
  const watcher = {
    running: false,
    start() { this.running = true; },
    stop() { this.running = false; }
  };
  const callControls = createCallControlsController({ log: { warn() {} } });
  const controller = createOverlayController({
    BrowserWindow: function BrowserWindow(options) {
      const window = new FakeWindow(options);
      windows.push(window);
      return window;
    },
    app: { getPath: () => userDataPath },
    appUrl: 'https://voiceroom.ru',
    callControls,
    createForegroundWatcher: () => watcher,
    fs,
    log: { warn() {} },
    path,
    platform: 'win32',
    processPid: VOICE_ROOM_PID,
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayMatching: () => ({ scaleFactor: 1, workArea: { height: 1080, width: 1920, x: 0, y: 0 } }),
      getDisplayNearestPoint: () => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }),
      getPrimaryDisplay: () => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } })
    }
  });
  t.after(() => controller.dispose());
  return { callControls, controller, watcher, windows };
}

function lastState(window) {
  return window.webContents.sent.filter(([channel]) => channel === STATE_CHANNEL).at(-1)[1];
}

const CS2 = {
  bounds: { height: 1080, width: 1920, x: 0, y: 0 },
  exe: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
  pid: 4242,
  title: 'Counter-Strike 2'
};

const CHROME = {
  bounds: { height: 1080, width: 1920, x: 0, y: 0 },
  exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  pid: 7,
  title: 'Gmail'
};

const VOICE_ROOM = {
  bounds: { height: 900, width: 1400, x: 100, y: 100 },
  exe: 'C:\\Users\\me\\AppData\\Local\\Programs\\voice-room-desktop\\Voice Room.exe',
  pid: VOICE_ROOM_PID,
  title: 'Voice Room'
};

const CUSTOM_GAME = {
  bounds: { height: 1080, width: 1920, x: 0, y: 0 },
  exe: 'D:\\Games\\MyGame\\mygame.exe',
  pid: 9,
  title: 'My Game'
};

describe('desktop overlay controller', () => {
  it('stays hidden until a game is in the foreground during a call', (t) => {
    const { callControls, controller, watcher, windows } = createHarness(t);
    const main = new FakeMainWindow();
    controller.attachMainWindow(main);
    assert.equal(watcher.running, false);

    callControls.setState(new FakeSender(), {
      active: true,
      roomId: 'abc123',
      roomName: 'Гостиная'
    });
    assert.equal(watcher.running, true);
    assert.equal(windows.length, 0);

    main.blur();
    assert.equal(windows.length, 0);

    controller.handleForeground(CHROME);
    assert.equal(windows.length, 0);

    controller.handleForeground(CS2);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, true);
    assert.equal(windows[0].alwaysOnTop.at(-1)[1], 'screen-saver');
    assert.deepEqual(windows[0].bounds, { height: 48, width: 52, x: 16, y: 16 });
    assert.match(windows[0].loaded.replace(/\\/g, '/'), /ui\/overlay.html$/);
  });

  it('always lets clicks through and never takes focus, whatever old settings say', (t) => {
    const { callControls, controller, windows } = createHarness(t);
    controller.attachMainWindow(new FakeMainWindow());
    callControls.setState(new FakeSender(), { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    const settings = controller.setSettings({
      clickThrough: false,
      interactiveBinding: { code: 'Backquote', ctrlKey: true },
      opacity: 1
    });
    assert.equal(Object.hasOwn(settings, 'clickThrough'), false);
    assert.equal(Object.hasOwn(settings, 'opacity'), false);
    assert.equal(Object.hasOwn(settings, 'interactiveBinding'), false);

    controller.handleForeground(CS2);
    assert.equal(windows[0].options.focusable, false);
    assert.deepEqual(windows[0].ignoreMouse, [[true, { forward: true }]]);
    assert.equal(windows[0].focused, false);
  });

  it('hides the overlay and stops watching windows when the call ends', (t) => {
    const { callControls, controller, watcher, windows } = createHarness(t);
    controller.attachMainWindow(new FakeMainWindow());
    const sender = new FakeSender();
    callControls.setState(sender, { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    controller.handleForeground(CS2);
    assert.equal(windows[0].visible, true);

    controller.handleForeground(CHROME);
    assert.equal(windows[0].visible, false);

    controller.handleForeground(CS2);
    callControls.setState(sender, { active: false });
    assert.equal(windows[0].visible, false);
    assert.equal(watcher.running, false);
  });

  it('keeps overlay settings when autostart later writes startMinimized', (t) => {
    const { controller } = createHarness(t);
    const settings = controller.setSettings({ enabled: false, anchor: 'bottom-right', avatarSize: 'large' });
    assert.equal(settings.enabled, false);
    assert.equal(settings.anchor, 'bottom-right');
    assert.equal(controller.getSettings().avatarSize, 'large');
    assert.equal(controller.getSettings().showNames, true);
  });

  it('lets the user allowlist a custom executable as a game', (t) => {
    const { callControls, controller, windows } = createHarness(t);
    controller.attachMainWindow(new FakeMainWindow());
    callControls.setState(new FakeSender(), { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    controller.handleForeground(CUSTOM_GAME);
    assert.equal(windows.length, 0);
    controller.setSettings({ allowedExecutables: ['mygame.exe'] });
    controller.handleForeground(CUSTOM_GAME);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].visible, true);
  });

  it('offers the last window before Voice Room for the allowlist, outside a call too', (t) => {
    const { controller, watcher } = createHarness(t);
    controller.attachMainWindow(new FakeMainWindow());
    assert.equal(watcher.running, false);

    assert.deepEqual(controller.getForeground(), { exe: '', game: false, label: '', reason: 'unknown', title: '' });
    assert.equal(watcher.running, true);

    controller.handleForeground(CUSTOM_GAME);
    controller.handleForeground(CHROME);
    controller.handleForeground(VOICE_ROOM);
    const offered = controller.getForeground();
    assert.equal(offered.exe, 'd:\\games\\mygame\\mygame.exe');
    assert.equal(offered.game, false);
    assert.equal(offered.title, 'My Game');

    assert.deepEqual(controller.addAllowedGame(VOICE_ROOM.exe).allowedExecutables, []);
    assert.deepEqual(controller.addAllowedGame(CHROME.exe).allowedExecutables, []);
    assert.deepEqual(controller.addAllowedGame().allowedExecutables, ['d:\\games\\mygame\\mygame.exe']);
    assert.equal(controller.getForeground().game, true);
  });

  it('sends avatars, mute state and streams to the overlay window', (t) => {
    const { callControls, controller, windows } = createHarness(t);
    controller.attachMainWindow(new FakeMainWindow());
    callControls.setState(new FakeSender(), { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    controller.handleForeground(CS2);
    controller.setSnapshot({
      participants: [{
        avatarUrl: '/api/avatars/key-1',
        id: 'a',
        micMuted: true,
        name: 'Ann',
        outputMuted: true,
        speaking: true,
        streaming: true
      }]
    });
    const state = lastState(windows[0]);
    const [participant] = state.participants;
    assert.equal(participant.avatarUrl, 'https://voiceroom.ru/api/avatars/key-1');
    assert.equal(participant.speaking, true);
    assert.equal(participant.micMuted, true);
    assert.equal(participant.outputMuted, true);
    assert.equal(participant.streaming, true);
    assert.deepEqual(state.settings, { avatarSize: 'medium', showNames: true });
  });

  it('previews sample participants when nobody is in a call', (t) => {
    const { controller, windows } = createHarness(t);
    controller.attachMainWindow(new FakeMainWindow());
    controller.startPreview();
    assert.equal(windows[0].visible, true);
    const state = lastState(windows[0]);
    assert.equal(state.participants.length, 2);
    assert.deepEqual(state.participants.map((participant) => participant.speaking), [true, false]);
  });
});
