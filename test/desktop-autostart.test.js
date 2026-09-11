'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  GET_CHANNEL,
  SETTINGS_FILE,
  SET_CHANNEL,
  createAutostartController
} = require('../electron/autostart');

function sameArgs(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Mirrors Electron 41 on Windows: `approved` is the StartupApproved value
// (undefined when absent). An entry registered with `enabled: true` has no
// StartupApproved value, so Electron leaves it out of `launchItems` and reports
// `executableWillLaunchAtLogin: false` even though Windows will launch it.
function createWindowsApp(userDataPath, { isPackaged = true } = {}) {
  const app = {
    isPackaged,
    runEntry: null,
    setCalls: [],
    getPath: () => userDataPath,
    getLoginItemSettings({ path: exePath, args } = {}) {
      const entry = app.runEntry;
      const listed = Boolean(entry && entry.approved !== undefined && entry.path === exePath);
      return {
        executableWillLaunchAtLogin: listed && entry.approved === true,
        launchItems: listed
          ? [{ args: entry.args, enabled: entry.approved, name: 'ru.dazinho.voiceroom', path: entry.path, scope: 'user' }]
          : [],
        openAtLogin: Boolean(entry && entry.path === exePath && sameArgs(entry.args, args))
      };
    },
    setLoginItemSettings(settings) {
      app.setCalls.push(settings);
      app.runEntry = settings.openAtLogin
        ? { approved: settings.enabled === false ? false : undefined, args: settings.args, path: settings.path }
        : null;
    }
  };
  return app;
}

function createHarness(t, { app, env = {}, platform = 'win32' } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-autostart-'));
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }));
  const resolvedApp = app ? app(userDataPath) : createWindowsApp(userDataPath);
  const controller = createAutostartController({
    app: resolvedApp,
    env,
    fs,
    log: { warn() {} },
    path,
    platform
  });
  return { app: resolvedApp, controller, userDataPath };
}

describe('desktop autostart controller', () => {
  it('reports unsupported development builds without touching login items', (t) => {
    const { app, controller } = createHarness(t, {
      app: (userDataPath) => createWindowsApp(userDataPath, { isPackaged: false })
    });

    assert.deepEqual(controller.getSettings(), {
      openAtLogin: false,
      reason: 'unsupported',
      startMinimized: false,
      supported: false
    });
    assert.equal(controller.setSettings({ openAtLogin: true }).supported, false);
    assert.deepEqual(app.setCalls, []);
  });

  it('registers, switches to hidden launch, and removes the Windows Run entry', (t) => {
    const { app, controller, userDataPath } = createHarness(t);
    const exePath = process.execPath;

    assert.deepEqual(controller.setSettings({ openAtLogin: true }), {
      openAtLogin: true,
      startMinimized: false,
      supported: true
    });
    assert.deepEqual(app.runEntry, { approved: undefined, args: [], path: exePath });
    assert.equal(controller.getSettings().openAtLogin, true);

    assert.deepEqual(controller.setSettings({ startMinimized: true }), {
      openAtLogin: true,
      startMinimized: true,
      supported: true
    });
    assert.deepEqual(app.runEntry, { approved: undefined, args: ['--hidden'], path: exePath });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(userDataPath, SETTINGS_FILE), 'utf8')),
      { startMinimized: true }
    );

    assert.deepEqual(controller.setSettings({ openAtLogin: false }), {
      openAtLogin: false,
      startMinimized: true,
      supported: true
    });
    assert.equal(app.runEntry, null);
    assert.equal(app.setCalls.length, 3);
  });

  it('stores the minimized preference without registering while autostart is off', (t) => {
    const { app, controller } = createHarness(t);

    assert.equal(controller.setSettings({ startMinimized: true }).startMinimized, true);
    assert.deepEqual(app.setCalls, []);

    controller.setSettings({ openAtLogin: true });
    assert.deepEqual(app.runEntry.args, ['--hidden']);
  });

  it('points the portable build login item at the original executable', (t) => {
    const { app, controller } = createHarness(t, {
      env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\Voice-Room-portable.exe' }
    });

    controller.setSettings({ openAtLogin: true });

    assert.equal(app.runEntry.path, 'D:\\Apps\\Voice-Room-portable.exe');
    assert.equal(controller.getSettings().openAtLogin, true);
  });

  it('reads a startup entry disabled in Task Manager as off and re-enables it', (t) => {
    const { app, controller } = createHarness(t);
    controller.setSettings({ openAtLogin: true });
    app.runEntry.approved = false;

    assert.equal(controller.getSettings().openAtLogin, false);

    controller.setSettings({ openAtLogin: true });
    assert.notEqual(app.runEntry.approved, false);
    assert.equal(controller.getSettings().openAtLogin, true);
  });

  it('reads a startup entry re-approved in Task Manager as on', (t) => {
    const { app, controller } = createHarness(t);
    controller.setSettings({ openAtLogin: true });
    app.runEntry.approved = true;

    assert.equal(controller.getSettings().openAtLogin, true);
  });

  it('uses plain login items on macOS', (t) => {
    const { app, controller } = createHarness(t, {
      app: (userDataPath) => {
        const macApp = {
          isPackaged: true,
          openAtLogin: false,
          setCalls: [],
          getPath: () => userDataPath,
          getLoginItemSettings: () => ({ openAtLogin: macApp.openAtLogin }),
          setLoginItemSettings(settings) {
            macApp.setCalls.push(settings);
            macApp.openAtLogin = settings.openAtLogin;
          }
        };
        return macApp;
      },
      platform: 'darwin'
    });

    controller.setSettings({ openAtLogin: true, startMinimized: true });
    controller.setSettings({ startMinimized: false });

    assert.deepEqual(app.setCalls, [{ openAtLogin: true }]);
    assert.deepEqual(controller.getSettings(), { openAtLogin: true, startMinimized: false, supported: true });
  });

  it('rejects untrusted renderer frames over IPC', async (t) => {
    const { app, controller } = createHarness(t);
    const handlers = new Map();
    controller.configureIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      isTrustedFrame: (frame) => frame?.url === 'https://voice.example/'
    });
    const untrusted = { senderFrame: { url: 'https://evil.example/' } };
    const trusted = { senderFrame: { url: 'https://voice.example/' } };

    assert.throws(() => handlers.get(GET_CHANNEL)(untrusted), /Desktop autostart is only available/);
    assert.throws(() => handlers.get(SET_CHANNEL)(untrusted, { openAtLogin: true }), /Desktop autostart is only available/);
    assert.deepEqual(app.setCalls, []);

    assert.equal(handlers.get(SET_CHANNEL)(trusted, { openAtLogin: true }).openAtLogin, true);
    assert.equal(handlers.get(GET_CHANNEL)(trusted).openAtLogin, true);
  });
});
