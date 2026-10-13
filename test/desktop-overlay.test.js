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
  moveTop() { this.raised = (this.raised || 0) + 1; }
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

function createHarness(t, { backend, screenToDipRect, onGameModeChange } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-overlay-'));
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }));
  const windows = [];
  const watcher = {
    running: false,
    ...(backend ? { getStatus: () => ({ backend, failures: 0, running: watcher.running }) } : {}),
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
    ...(onGameModeChange ? { onGameModeChange } : {}),
    path,
    platform: 'win32',
    processPid: VOICE_ROOM_PID,
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayMatching: () => ({ scaleFactor: 1, workArea: { height: 1080, width: 1920, x: 0, y: 0 } }),
      getDisplayNearestPoint: () => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }),
      getPrimaryDisplay: () => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }),
      ...(screenToDipRect ? { screenToDipRect } : {})
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

describe('desktop overlay placement and health', () => {
  const SECOND_MONITOR_GAME = {
    ...CS2,
    bounds: { height: 1440, width: 2560, x: 2880, y: 0 }
  };
  const halveRect = (_window, rect) => ({
    height: rect.height / 2,
    width: rect.width / 2,
    x: rect.x / 2,
    y: rect.y / 2
  });

  function startCall(callControls, controller) {
    const main = new FakeMainWindow();
    controller.attachMainWindow(main);
    callControls.setState(new FakeSender(), { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    main.blur();
  }

  it('converts native helper bounds (physical pixels) to DIP before placing the HUD', (t) => {
    const { callControls, controller, windows } = createHarness(t, { backend: 'native', screenToDipRect: halveRect });
    startCall(callControls, controller);
    controller.handleForeground(SECOND_MONITOR_GAME);
    assert.deepEqual(windows[0].bounds, { height: 48, width: 52, x: 1456, y: 16 });
  });

  it('uses PowerShell bounds as they are, since Windows already scales them', (t) => {
    const { callControls, controller, windows } = createHarness(t, { backend: 'powershell', screenToDipRect: halveRect });
    startCall(callControls, controller);
    controller.handleForeground(SECOND_MONITOR_GAME);
    assert.deepEqual(windows[0].bounds, { height: 48, width: 52, x: 2896, y: 16 });
  });

  it('raises the HUD again on every report and after a GPU process crash', (t) => {
    const { callControls, controller, windows } = createHarness(t, { backend: 'native' });
    startCall(callControls, controller);
    controller.handleForeground(CS2);
    const raised = windows[0].raised;
    controller.handleForeground({ ...CS2, title: 'Counter-Strike 2 - round 2' });
    assert.equal(windows[0].raised, raised + 1);

    const topmostCalls = windows[0].alwaysOnTop.length;
    controller.recoverFromGpuCrash();
    assert.equal(windows[0].alwaysOnTop.length > topmostCalls, true);
    assert.equal(windows[0].raised, raised + 2);
  });

  it('reports status without paths', (t) => {
    const { callControls, controller } = createHarness(t, { backend: 'native' });
    assert.deepEqual(controller.getStatus(), { enabled: true, game: '', visible: false, watcher: 'stopped' });
    startCall(callControls, controller);
    controller.handleForeground(CS2);
    assert.deepEqual(controller.getStatus(), { enabled: true, game: 'cs2.exe', visible: true, watcher: 'native' });
  });
});

describe('desktop overlay game mode', () => {
  function gameModeHarness(t) {
    const changes = [];
    const harness = createHarness(t, { onGameModeChange: (active) => changes.push(active) });
    const main = new FakeMainWindow();
    harness.controller.attachMainWindow(main);
    return { ...harness, changes, main };
  }

  function focusMain(main) {
    main.focused = true;
    main.emit('focus');
  }

  it('is on while a game is on screen during a call and the app window is not in front', (t) => {
    const { callControls, changes, controller, main } = gameModeHarness(t);
    controller.handleForeground(CS2);
    assert.deepEqual(changes, [], 'no call, no game mode');

    const page = new FakeSender();
    callControls.setState(page, { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    main.blur();
    controller.handleForeground(CS2);
    assert.deepEqual(changes, [true]);
    assert.equal(controller.isGameMode(), true);

    controller.handleForeground({ ...CS2, title: 'Counter-Strike 2 - round 2' });
    assert.deepEqual(changes, [true], 'reported once per change');

    focusMain(main);
    assert.deepEqual(changes, [true, false], 'the app window in front ends it');
    main.blur();
    assert.deepEqual(changes, [true, false, true], 'back to the game that was last in front');
    controller.handleForeground(CHROME);
    assert.deepEqual(changes, [true, false, true, false], 'a browser over the game is not game mode');

    controller.handleForeground(CS2);
    assert.deepEqual(changes, [true, false, true, false, true]);
    callControls.setState(page, { active: false });
    assert.deepEqual(changes, [true, false, true, false, true, false], 'leaving the call ends it');
  });

  it('stays off with the overlay switched off, and ends on dispose', (t) => {
    const { callControls, changes, controller, main } = gameModeHarness(t);
    controller.setSettings({ enabled: false });
    callControls.setState(new FakeSender(), { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    main.blur();
    controller.handleForeground(CS2);
    assert.deepEqual(changes, []);

    controller.setSettings({ enabled: true });
    controller.handleForeground(CS2);
    assert.deepEqual(changes, [true]);
    controller.dispose();
    assert.deepEqual(changes, [true, false]);
  });
});

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

  it('keeps the overlay over a background game until it is covered, minimized or closed', (t) => {
    const { callControls, controller, windows } = createHarness(t);
    controller.attachMainWindow(new FakeMainWindow());
    callControls.setState(new FakeSender(), { active: true, roomId: 'abc123', roomName: 'Гостиная' });
    const gameBounds = { height: 1080, width: 1920, x: 0, y: 0 };
    const gameWindow = { bounds: gameBounds, hwnd: 101, minimized: false };
    controller.handleForeground({ ...CS2, bounds: gameBounds, hwnd: 101, windows: [gameWindow] });
    assert.equal(windows[0].visible, true);

    const onSecondMonitor = { ...CHROME, bounds: { height: 1096, width: 1936, x: 1912, y: -8 }, hwnd: 202 };
    controller.handleForeground({ ...onSecondMonitor, windows: [{ bounds: onSecondMonitor.bounds, hwnd: 202 }, gameWindow] });
    assert.equal(windows[0].visible, true);

    const overGame = { ...CHROME, bounds: { height: 700, width: 900, x: 300, y: 200 }, hwnd: 202 };
    controller.handleForeground({ ...overGame, windows: [{ bounds: overGame.bounds, hwnd: 202 }, gameWindow] });
    assert.equal(windows[0].visible, false);

    const desktop = {
      bounds: { height: 1080, width: 3840, x: 0, y: 0 },
      exe: 'C:\\Windows\\explorer.exe',
      hwnd: 303,
      pid: 55,
      title: 'Program Manager'
    };
    const desktopWindow = { bounds: desktop.bounds, hwnd: 303 };
    controller.handleForeground({ ...desktop, windows: [desktopWindow, gameWindow] });
    assert.equal(windows[0].visible, true);

    controller.handleForeground({ ...desktop, windows: [desktopWindow, { ...gameWindow, minimized: true }] });
    assert.equal(windows[0].visible, false);

    controller.handleForeground({ ...desktop, windows: [desktopWindow, gameWindow] });
    assert.equal(windows[0].visible, true);

    // The game window is gone from the helper's list: the game was closed.
    controller.handleForeground({ ...desktop, windows: [desktopWindow] });
    assert.equal(windows[0].visible, false);
    controller.handleForeground({ ...desktop, windows: [desktopWindow, gameWindow] });
    assert.equal(windows[0].visible, false);
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
    assert.deepEqual(state.settings, { anchor: 'top-left', avatarSize: 'medium', showNames: true });

    // The overlay page mirrors rows in the right corners, so it needs the anchor.
    controller.setSettings({ anchor: 'bottom-right' });
    assert.equal(lastState(windows[0]).settings.anchor, 'bottom-right');
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
