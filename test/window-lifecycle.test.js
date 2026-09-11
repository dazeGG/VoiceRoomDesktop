'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createWindowLifecycleController } = require('../electron/window/lifecycle');

function createFakeWindow() {
  const handlers = new Map();
  const onceHandlers = new Map();
  const webContentsHandlers = new Map();
  const calls = [];
  const window = {
    calls,
    hidden: false,
    minimized: false,
    visible: true,
    destroyed: false,
    webContents: {
      on: (event, handler) => {
        webContentsHandlers.set(event, handler);
      }
    },
    emit: (event, ...args) => {
      handlers.get(event)?.(...args);
      onceHandlers.get(event)?.(...args);
      onceHandlers.delete(event);
    },
    emitWebContents: (event, ...args) => {
      webContentsHandlers.get(event)?.(...args);
    },
    focus: () => calls.push('focus'),
    hide: () => {
      calls.push('hide');
      window.hidden = true;
      window.visible = false;
    },
    isDestroyed: () => window.destroyed,
    isMinimized: () => window.minimized,
    isVisible: () => window.visible,
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    once: (event, handler) => {
      onceHandlers.set(event, handler);
    },
    restore: () => {
      calls.push('restore');
      window.minimized = false;
    },
    show: () => {
      calls.push('show');
      window.hidden = false;
      window.visible = true;
    }
  };
  return window;
}

function createControllerHarness({ platform = 'win32' } = {}) {
  const appCalls = [];
  const trayInstances = [];
  class FakeTray {
    constructor(iconPath) {
      this.calls = [];
      this.handlers = new Map();
      this.iconPath = iconPath;
      trayInstances.push(this);
    }
    destroy() {
      this.calls.push('destroy');
    }
    emit(event) {
      this.handlers.get(event)?.();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    setImage(iconPath) {
      this.iconPath = iconPath;
    }
    setToolTip(text) {
      this.tooltip = text;
    }
  }
  const controller = createWindowLifecycleController({
    Menu: {
      buildFromTemplate: (template) => template
    },
    Tray: FakeTray,
    app: {
      quit: () => appCalls.push('quit')
    },
    platform,
    resolveTrayIconPath: ({ inCall = false } = {}) => (inCall ? 'in-call.png' : 'icon.ico')
  });
  return { appCalls, controller, trayInstances };
}

describe('window lifecycle controller', () => {
  it('hides Windows titlebar close to tray', () => {
    const { controller } = createControllerHarness();
    const window = createFakeWindow();
    controller.installTray();
    controller.attachMainWindow(window);
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };

    window.emit('close', event);

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(window.calls, ['hide']);
    assert.equal(controller.shouldQuitForWindowAllClosed(), false);
  });

  it('lets Alt+F4 close and quit for real', () => {
    const { controller } = createControllerHarness();
    const window = createFakeWindow();
    controller.installTray();
    controller.attachMainWindow(window);
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };

    window.emitWebContents('before-input-event', {}, { type: 'keyDown', alt: true, key: 'F4' });
    window.emit('close', event);

    assert.equal(event.defaultPrevented, false);
    assert.equal(controller.shouldQuitForWindowAllClosed(), true);
  });

  it('restores the attached main window from tray/menu without falling back to other windows', () => {
    const { controller, trayInstances } = createControllerHarness();
    const window = createFakeWindow();
    window.visible = false;
    window.minimized = true;
    controller.installTray();
    controller.attachMainWindow(window);

    trayInstances[0].emit('click');

    assert.deepEqual(window.calls, ['restore', 'show', 'focus']);
    window.calls.length = 0;
    assert.equal(trayInstances[0].menu[0].label, 'Открыть Voice Room');
    trayInstances[0].menu[0].click();
    assert.deepEqual(window.calls, ['focus']);
  });

  it('uses tray menu exit as an explicit real quit path', () => {
    const { appCalls, controller, trayInstances } = createControllerHarness();
    const window = createFakeWindow();
    controller.installTray();
    controller.attachMainWindow(window);

    assert.equal(trayInstances[0].menu[1].label, 'Выход');
    trayInstances[0].menu[1].click();

    assert.equal(controller.isQuitRequested(), true);
    assert.deepEqual(appCalls, ['quit']);
    assert.equal(controller.shouldQuitForWindowAllClosed(), true);
  });

  it('does not keep a Windows app alive before the main app shell enables tray', () => {
    const { controller, trayInstances } = createControllerHarness();

    assert.equal(controller.hasTray(), false);
    assert.equal(trayInstances.length, 0);
    assert.equal(controller.restoreMainWindow(), false);
    assert.equal(controller.shouldQuitForWindowAllClosed(), true);
  });

  it('does not install tray behavior on macOS', () => {
    const { controller, trayInstances } = createControllerHarness({ platform: 'darwin' });
    const window = createFakeWindow();
    controller.installTray();
    controller.attachMainWindow(window);
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };

    window.emit('close', event);

    assert.equal(event.defaultPrevented, false);
    assert.equal(trayInstances.length, 0);
    assert.equal(controller.shouldQuitForWindowAllClosed(), false);
  });

  it('shows a ready update between open and exit in the tray menu', () => {
    const { controller, trayInstances } = createControllerHarness();
    const installs = [];
    controller.installTray();

    controller.setUpdateAction({ label: 'Установить обновление 1.3.0', click: () => installs.push(true) });
    assert.deepEqual(trayInstances[0].menu.map(({ label }) => label), [
      'Открыть Voice Room',
      'Установить обновление 1.3.0',
      'Выход'
    ]);
    trayInstances[0].menu[1].click();
    assert.deepEqual(installs, [true]);

    controller.setUpdateAction(null);
    assert.deepEqual(trayInstances[0].menu.map(({ label }) => label), ['Открыть Voice Room', 'Выход']);
  });

  it('shows call controls, tooltip and the in-call icon only during a call', () => {
    const { controller, trayInstances } = createControllerHarness();
    const clicks = [];
    controller.installTray();
    const tray = trayInstances[0];
    assert.equal(tray.iconPath, 'icon.ico');
    assert.equal(tray.tooltip, 'Voice Room');

    controller.setCallMenu({
      inCall: true,
      items: [
        { label: 'Выключить микрофон', click: () => clicks.push('mic') },
        { label: 'Отключиться', click: () => clicks.push('leave') }
      ],
      tooltip: 'Voice Room — Гостиная'
    });
    assert.deepEqual(tray.menu.map(({ label, type }) => label || type), [
      'Открыть Voice Room',
      'separator',
      'Выключить микрофон',
      'Отключиться',
      'separator',
      'Выход'
    ]);
    assert.equal(tray.tooltip, 'Voice Room — Гостиная');
    assert.equal(tray.iconPath, 'in-call.png');
    tray.menu[3].click();
    assert.deepEqual(clicks, ['leave']);

    controller.setCallMenu({ inCall: false, items: [], tooltip: 'Voice Room' });
    assert.deepEqual(tray.menu.map(({ label }) => label), ['Открыть Voice Room', 'Выход']);
    assert.equal(tray.iconPath, 'icon.ico');
    assert.equal(tray.tooltip, 'Voice Room');
  });

  it('creates the tray with the call state set before it existed', () => {
    const { controller, trayInstances } = createControllerHarness();
    controller.setCallMenu({ inCall: true, items: [{ label: 'Отключиться', click() {} }], tooltip: 'Voice Room — в звонке' });
    controller.installTray();

    assert.equal(trayInstances[0].iconPath, 'in-call.png');
    assert.equal(trayInstances[0].tooltip, 'Voice Room — в звонке');
    assert.equal(trayInstances[0].menu[2].label, 'Отключиться');
  });

  it('adds a diagnostics submenu above exit', () => {
    const { controller, trayInstances } = createControllerHarness();
    const calls = [];
    controller.installTray();
    controller.setUpdateAction({ label: 'Установить обновление 1.3.1', click() {} });
    controller.setDiagnosticsActions({
      copyInfo: () => calls.push('copy'),
      openLogsFolder: () => calls.push('logs')
    });

    const menu = trayInstances[0].menu;
    assert.deepEqual(menu.map(({ label }) => label), ['Открыть Voice Room', 'Установить обновление 1.3.1', 'Диагностика', 'Выход']);
    assert.deepEqual(menu[2].submenu.map(({ label }) => label), ['Открыть папку логов', 'Скопировать информацию о системе']);
    menu[2].submenu.forEach((item) => item.click());
    assert.deepEqual(calls, ['logs', 'copy']);

    controller.setDiagnosticsActions(null);
    assert.deepEqual(trayInstances[0].menu.map(({ label }) => label), ['Открыть Voice Room', 'Установить обновление 1.3.1', 'Выход']);
  });

  it('exposes the live main window only', () => {
    const { controller } = createControllerHarness();
    assert.equal(controller.getMainWindow(), null);
    const window = createFakeWindow();
    controller.attachMainWindow(window);
    assert.equal(controller.getMainWindow(), window);
    window.destroyed = true;
    assert.equal(controller.getMainWindow(), null);
  });

  it('reports main window visibility for background update deferral', () => {
    const { controller } = createControllerHarness();
    assert.equal(controller.isMainWindowVisible(), false);

    const window = createFakeWindow();
    controller.installTray();
    controller.attachMainWindow(window);
    assert.equal(controller.isMainWindowVisible(), true);

    window.emit('close', { preventDefault() {} });
    assert.equal(controller.isMainWindowVisible(), false);
  });
});
