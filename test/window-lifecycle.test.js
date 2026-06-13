'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createWindowLifecycleController } = require('../electron/window-lifecycle');

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
    resolveTrayIconPath: () => 'icon.ico'
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
});
