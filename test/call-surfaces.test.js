'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { describe, it } = require('node:test');
const { INACTIVE_CALL_STATE } = require('../electron/call-controls');
const {
  CALL_ICONS_DIR,
  PERSONALIZE_REGISTRY_KEY,
  buildThumbarButtons,
  createCallSurfaces,
  createWindowsTaskbarThemeReader,
  parseSystemUsesLightTheme,
  resolveCallIconPath
} = require('../electron/window/call-surfaces');

const ACTIVE = { active: true, micMuted: true, outputMuted: false, roomId: 'abc123', roomName: 'Гостиная' };

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.thumbarCalls = [];
  }

  isDestroyed() { return this.destroyed; }
  setThumbarButtons(buttons) { this.thumbarCalls.push(buttons); }
}

function createHarness({ platform = 'win32', dark = true } = {}) {
  const dispatched = [];
  const callMenus = [];
  const dockMenus = [];
  const loadedIcons = [];
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: dark });
  const window = new FakeWindow();
  const surfaces = createCallSurfaces({
    app: { dock: { setMenu: (menu) => dockMenus.push(menu) } },
    Menu: { buildFromTemplate: (template) => template },
    dispatch: (action) => dispatched.push(action),
    nativeImage: {
      createFromPath: (iconPath) => {
        loadedIcons.push(iconPath);
        return { iconPath };
      }
    },
    nativeTheme,
    platform,
    windowLifecycle: {
      getMainWindow: () => window,
      setCallMenu: (menu) => callMenus.push(menu)
    }
  });
  return { callMenus, dispatched, dockMenus, loadedIcons, nativeTheme, surfaces, window };
}

describe('call surface helpers', () => {
  it('picks the glyph colour for the shell theme', () => {
    assert.equal(resolveCallIconPath('mic'), path.join(CALL_ICONS_DIR, 'mic-light.png'));
    assert.equal(resolveCallIconPath('mic', { dark: false }), path.join(CALL_ICONS_DIR, 'mic-dark.png'));
  });

  it('builds thumbar buttons that dispatch their action', () => {
    const dispatched = [];
    const buttons = buildThumbarButtons(ACTIVE, { dispatch: (action) => dispatched.push(action), loadIcon: (icon) => icon });

    assert.deepEqual(buttons.map(({ icon, tooltip }) => [icon, tooltip]), [
      ['mic-off', 'Включить микрофон'],
      ['headphones', 'Выключить звук'],
      ['phone-off', 'Отключиться']
    ]);
    buttons.forEach((button) => button.click());
    assert.deepEqual(dispatched, ['toggle-mic', 'toggle-output', 'disconnect']);
    assert.deepEqual(buildThumbarButtons(INACTIVE_CALL_STATE, { dispatch() {}, loadIcon() {} }), []);
  });
});

describe('call surfaces on Windows', () => {
  it('mirrors the call into the tray and the taskbar toolbar', () => {
    const harness = createHarness();

    harness.surfaces.apply(ACTIVE);
    assert.equal(harness.callMenus.length, 1);
    assert.equal(harness.callMenus[0].inCall, true);
    assert.equal(harness.callMenus[0].tooltip, 'Voice Room — Гостиная');
    assert.deepEqual(harness.callMenus[0].items.map(({ label }) => label), ['Включить микрофон', 'Выключить звук', 'Отключиться']);
    harness.callMenus[0].items[2].click();
    assert.deepEqual(harness.dispatched, ['disconnect']);
    assert.equal(harness.window.thumbarCalls.at(-1).length, 3);
    assert.deepEqual(harness.window.thumbarCalls.at(-1)[0].icon, { iconPath: path.join(CALL_ICONS_DIR, 'mic-off-light.png') });

    harness.surfaces.apply(INACTIVE_CALL_STATE);
    assert.deepEqual(harness.callMenus.at(-1), { inCall: false, items: [], tooltip: 'Voice Room' });
    assert.deepEqual(harness.window.thumbarCalls.at(-1), []);
  });

  it('re-applies the toolbar when the window returns from the tray, with one listener', () => {
    const harness = createHarness();
    harness.surfaces.apply(ACTIVE);
    harness.surfaces.apply({ ...ACTIVE, micMuted: false });
    assert.equal(harness.window.listenerCount('show'), 1);

    const before = harness.window.thumbarCalls.length;
    harness.window.emit('show');
    assert.equal(harness.window.thumbarCalls.length, before + 1);
    assert.equal(harness.window.thumbarCalls.at(-1)[0].tooltip, 'Выключить микрофон');
  });

  it('loads each icon file once and follows theme changes', () => {
    const harness = createHarness();
    harness.surfaces.apply(ACTIVE);
    harness.surfaces.apply({ ...ACTIVE, roomName: 'Другая' });
    assert.equal(harness.loadedIcons.length, 3);

    harness.nativeTheme.shouldUseDarkColors = false;
    harness.nativeTheme.emit('updated');
    assert.deepEqual(harness.window.thumbarCalls.at(-1)[0].icon, { iconPath: path.join(CALL_ICONS_DIR, 'mic-off-dark.png') });
  });

  it('applies the current call to a newly attached window', () => {
    const harness = createHarness();
    const lateWindow = new FakeWindow();
    harness.surfaces.attachWindow(lateWindow);
    assert.deepEqual(lateWindow.thumbarCalls, [], 'nothing known yet');

    harness.surfaces.apply(ACTIVE);
    harness.surfaces.attachWindow(lateWindow);
    assert.equal(lateWindow.thumbarCalls.at(-1).length, 3);
  });
});

describe('Windows taskbar theme', () => {
  const BACKSLASH = String.fromCharCode(92);

  it('parses the reg query output', () => {
    assert.equal(PERSONALIZE_REGISTRY_KEY.split(BACKSLASH).join('/'), 'HKCU/Software/Microsoft/Windows/CurrentVersion/Themes/Personalize');
    assert.equal(parseSystemUsesLightTheme('    SystemUsesLightTheme    REG_DWORD    0x0'), false);
    assert.equal(parseSystemUsesLightTheme('    SystemUsesLightTheme    REG_DWORD    0x1'), true);
    assert.equal(parseSystemUsesLightTheme('ERROR: nothing'), null);
  });

  it('reads the theme in the background, notifies real changes and defaults to dark', () => {
    const calls = [];
    const reader = createWindowsTaskbarThemeReader({
      execFile: (file, args, _options, callback) => calls.push({ args, callback, file }),
      log: { warn() {} }
    });
    const changes = [];
    reader.subscribe(() => changes.push(reader.isDark()));

    assert.equal(reader.isDark(), true, 'dark until the first read returns');
    assert.equal(calls.length, 1, 'the first read starts immediately');
    assert.deepEqual([calls[0].file, calls[0].args], ['reg', ['query', PERSONALIZE_REGISTRY_KEY, '/v', 'SystemUsesLightTheme']]);

    reader.invalidate();
    assert.equal(calls.length, 1, 'a read in flight is not duplicated');
    calls[0].callback(null, 'SystemUsesLightTheme    REG_DWORD    0x1');
    assert.equal(reader.isDark(), false);
    assert.deepEqual(changes, [false]);
    assert.equal(calls.length, 2, 'the queued re-read runs afterwards');

    calls[1].callback(null, 'SystemUsesLightTheme    REG_DWORD    0x1');
    assert.deepEqual(changes, [false], 'an unchanged theme does not notify');

    reader.invalidate();
    calls[2].callback(new Error('no reg'));
    assert.equal(reader.isDark(), true);
    assert.deepEqual(changes, [false, true]);
  });

  it('picks glyphs from the taskbar theme and re-reads it after a theme change', () => {
    const harness = createHarness();
    let invalidations = 0;
    let themeListener = null;
    const lightTaskbar = createCallSurfaces({
      app: {},
      Menu: { buildFromTemplate: (template) => template },
      dispatch() {},
      nativeImage: { createFromPath: (iconPath) => ({ iconPath }) },
      nativeTheme: harness.nativeTheme,
      platform: 'win32',
      taskbarTheme: {
        invalidate: () => { invalidations += 1; },
        isDark: () => false,
        subscribe: (listener) => { themeListener = listener; }
      },
      windowLifecycle: { getMainWindow: () => harness.window, setCallMenu() {} }
    });

    lightTaskbar.apply(ACTIVE);
    assert.deepEqual(harness.window.thumbarCalls.at(-1)[0].icon, { iconPath: path.join(CALL_ICONS_DIR, 'mic-off-dark.png') });
    harness.nativeTheme.emit('updated');
    assert.equal(invalidations, 1);

    const before = harness.window.thumbarCalls.length;
    themeListener();
    assert.equal(harness.window.thumbarCalls.length, before + 1, 'a finished background read re-applies the toolbar');
  });
});

describe('call surfaces on macOS', () => {
  it('fills and clears the Dock menu without touching the tray', () => {
    const harness = createHarness({ platform: 'darwin' });

    harness.surfaces.apply(ACTIVE);
    assert.deepEqual(harness.dockMenus.at(-1).map(({ label }) => label), ['Включить микрофон', 'Выключить звук', 'Отключиться']);
    harness.dockMenus.at(-1)[0].click();
    assert.deepEqual(harness.dispatched, ['toggle-mic']);

    harness.surfaces.apply(INACTIVE_CALL_STATE);
    assert.deepEqual(harness.dockMenus.at(-1), []);
    assert.deepEqual(harness.callMenus, []);
    assert.deepEqual(harness.window.thumbarCalls, []);
  });
});
