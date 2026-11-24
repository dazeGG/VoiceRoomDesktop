'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-room-main-policy-'));
test.after(() => fs.rmSync(userDataRoot, { recursive: true, force: true }));

function createElectronMock() {
  const app = {
    commandLine: { appendSwitch() {} },
    getAppPath: () => path.join(__dirname, '..'),
    getPath: () => userDataRoot,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on() {},
    quit() {},
    requestSingleInstanceLock: () => true,
    setAppUserModelId() {},
    setAsDefaultProtocolClient: () => true,
    whenReady: () => new Promise(() => {})
  };

  class BrowserWindow {
    static fromWebContents() { return null; }
    static getAllWindows() { return []; }
  }

  return {
    app,
    BrowserWindow,
    dialog: { showErrorBox() {} },
    ipcMain: { handle() {} },
    Menu: { setApplicationMenu() {} },
    session: {
      defaultSession: {
        setDisplayMediaRequestHandler() {},
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {}
      }
    },
    shell: { openExternal: () => Promise.resolve() },
    Tray: class Tray {}
  };
}

test('main process module load tolerates an invalid startup app URL', () => {
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');
  const originalVoiceRoomUrl = process.env.VOICE_ROOM_URL;
  const originalLoad = Module._load;
  const electronMock = createElectronMock();

  process.env.VOICE_ROOM_URL = 'not a valid url';
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(mainPath)];

    assert.doesNotThrow(() => require(mainPath));
  } finally {
    delete require.cache[require.resolve(mainPath)];
    Module._load = originalLoad;
    if (originalVoiceRoomUrl === undefined) {
      delete process.env.VOICE_ROOM_URL;
    } else {
      process.env.VOICE_ROOM_URL = originalVoiceRoomUrl;
    }
  }
});

const voiceStartupCases = [
  { name: 'packaged release', isPackaged: true, channel: 'release', platform: 'win32', arch: 'x64', enabled: true },
  { name: 'packaged release ignores overrides', isPackaged: true, channel: 'release', platform: 'win32', arch: 'x64', enabled: true, ignoreOverride: true },
  { name: 'packaged development', isPackaged: true, channel: 'dev', platform: 'win32', arch: 'x64', enabled: true, override: true },
  { name: 'checkout', platform: 'win32', arch: 'x64', enabled: true },
  { name: 'checkout with overrides', platform: 'win32', arch: 'x64', enabled: true, override: true },
  { name: 'local kill switch', platform: 'win32', arch: 'x64', flag: '0' },
  { name: 'Linux with legacy opt-in', platform: 'linux', arch: 'x64', flag: '1' },
  { name: 'Windows ARM64', platform: 'win32', arch: 'arm64' }
];

for (const { name, isPackaged = false, channel, platform, arch, enabled, override, ignoreOverride, flag } of voiceStartupCases) {
  test(`main process native voice startup policy for ${name}`, async (t) => {
    const mainPath = require.resolve('../electron/main');
    const originalLoad = Module._load;
    const electronMock = createElectronMock();
    electronMock.app.isPackaged = isPackaged;
    const handlers = new Map();
    electronMock.ipcMain = new EventEmitter();
    electronMock.ipcMain.handle = (key, handler) => handlers.set(key, handler);
    const origin = channel === 'release' ? 'https://app.voiceroom.ru' : 'https://app.dev.voiceroom.ru';
    const appUrl = `${origin}/room?desktop=1`;
    const extraOrigin = 'wss://media.test:8443';
    const env = {
      VOICE_ROOM_URL: isPackaged ? undefined : appUrl,
      VOICE_ROOM_NATIVE_VOICE: flag,
      VOICE_ROOM_NATIVE_VOICE_ORIGINS: override || ignoreOverride ? extraOrigin : undefined
    };
    for (const [key, value] of Object.entries(env)) {
      const previous = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    for (const [key, value] of Object.entries({ platform, arch })) {
      const descriptor = Object.getOwnPropertyDescriptor(process, key);
      Object.defineProperty(process, key, { ...descriptor, value });
      t.after(() => Object.defineProperty(process, key, descriptor));
    }
    const readFileSync = fs.readFileSync;
    const statSync = fs.statSync;
    let helperLookups = 0;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (typeof file === 'string' && file.endsWith('runtime-config.json')) {
        return JSON.stringify({ voiceRoomUrl: isPackaged ? appUrl : 'https://runtime-config.test' });
      }
      if (typeof file === 'string' && file.endsWith('build-profile.json')) {
        return JSON.stringify({ channel });
      }
      return readFileSync(file, ...args);
    });
    t.mock.method(fs, 'statSync', (file, ...args) => {
      if (typeof file === 'string' && file.endsWith('VoiceRoomVoice.exe')) {
        helperLookups += 1;
        return undefined;
      }
      return statSync(file, ...args);
    });
    let supervisorLoads = 0;
    let bridge;
    let bootstrap;
    Module._load = function loadWithElectronMock(request, parent, isMain) {
      if (request === 'electron') return electronMock;
      const result = originalLoad.call(this, request, parent, isMain);
      if (parent?.filename !== mainPath) return result;
      if (request === './native/voice') supervisorLoads += 1;
      if (request === './native/voice-ipc') return {
        createNativeVoiceIpc(options) {
          bridge = result.createNativeVoiceIpc(options);
          return bridge;
        }
      };
      if (request === './app/bootstrap') return {
        createAppBootstrap(options) {
          bootstrap = options;
          return { launchApplication: () => Promise.resolve() };
        }
      };
      return result;
    };
    t.after(() => {
      delete require.cache[mainPath];
      Module._load = originalLoad;
    });

    require(mainPath);
    assert.equal(bootstrap.appUrl, appUrl);
    assert.deepEqual(bootstrap.mainWindowArguments, enabled ? [`--voice-room-native-voice-origin=${origin}`] : []);
    assert.equal(Boolean(bridge), Boolean(enabled));
    assert.equal(supervisorLoads, 0);
    assert.equal(helperLookups, 0);
    if (!enabled) return;

    const window = new EventEmitter();
    const webContents = new EventEmitter();
    const frame = { origin, url: appUrl, send() {} };
    webContents.mainFrame = frame;
    webContents.isDestroyed = () => false;
    window.webContents = webContents;
    bridge.configure();
    bridge.attachWindow(window);
    webContents.emit('did-navigate');

    const ipcEvent = { sender: webContents, senderFrame: frame };
    const invoke = (name, ...args) => handlers.get(`desktop-native-voice:${name}`)(ipcEvent, ...args);
    electronMock.ipcMain.emit('desktop-native-voice:expose', ipcEvent);
    assert.equal(ipcEvent.returnValue, true);
    assert.equal(invoke('get-capability').available, true);
    assert.equal(supervisorLoads, 0);
    assert.equal(helperLookups, 0);

    frame.origin = 'https://foreign.test';
    frame.url = frame.origin + '/room';
    electronMock.ipcMain.emit('desktop-native-voice:expose', ipcEvent);
    assert.equal(ipcEvent.returnValue, false);
    assert.throws(() => invoke('get-capability'), { code: 'untrusted-frame' });
    assert.throws(() => invoke('list-outputs'), { code: 'untrusted-frame' });
    frame.origin = origin;
    frame.url = appUrl;

    const admission = { callId: 'call', tracks: [], token: 'test.jwt.signature', outputDeviceId: null, muted: true };
    const defaultMediaOrigin = origin.replace('https:', 'wss:');
    const denied = override ? defaultMediaOrigin : extraOrigin;
    assert.deepEqual(invoke('start', { ...admission, url: denied }), { ok: false, code: 'bad-payload' });
    assert.equal(supervisorLoads, 0);
    assert.equal(helperLookups, 0);

    await assert.rejects(invoke('list-outputs'), { message: 'helper-unavailable' });
    assert.equal(supervisorLoads, 1);
    assert.ok(helperLookups > 0);

    const allowed = override ? extraOrigin : defaultMediaOrigin;
    assert.deepEqual(await invoke('start', { ...admission, url: allowed }), { ok: false, code: 'helper-unavailable' });
    assert.equal(supervisorLoads, 1);
    assert.ok(helperLookups > 0);
  });
}

test('main process disables intensive wake-up throttling in its single disable-features switch', () => {
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');
  const originalLoad = Module._load;
  const electronMock = createElectronMock();
  const switches = [];
  electronMock.app.commandLine.appendSwitch = (name, value) => switches.push([name, value]);

  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(mainPath)];
    require(mainPath);
    const disableFeatures = switches.filter(([name]) => name === 'disable-features');
    assert.equal(disableFeatures.length, 1, 'a second disable-features switch would replace the first');
    assert.ok(disableFeatures[0][1].split(',').includes('IntensiveWakeUpThrottling'));
    if (process.platform === 'win32' && process.env.VOICE_ROOM_WEBRTC_HW_ENCODER !== '0') {
      assert.ok(disableFeatures[0][1].split(',').includes('WebRtcScreenshareSwEncoding'));
    }
  } finally {
    delete require.cache[require.resolve(mainPath)];
    Module._load = originalLoad;
  }
});

test('main process wires window bootstrap installers into app bootstrap', () => {
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');
  const originalLoad = Module._load;
  const electronMock = createElectronMock();
  let capturedOptions;

  Module._load = function loadWithBootstrapCapture(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === './app/bootstrap') {
      return {
        createAppBootstrap(options) {
          capturedOptions = options;
          return {
            launchApplication: () => Promise.resolve()
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(mainPath)];

    assert.doesNotThrow(() => require(mainPath));
    assert.equal(typeof capturedOptions.installMediaDeviceFilter, 'function');
    assert.equal(typeof capturedOptions.installNativeCaptureBridge, 'function');
    assert.equal(capturedOptions.installBuildLabel, undefined);
    assert.equal(typeof capturedOptions.showRendererRecovery, 'function');
    assert.equal(typeof capturedOptions.openAdmin, 'function');
    assert.equal(typeof capturedOptions.classifyAppUrl, 'function');
  } finally {
    delete require.cache[require.resolve(mainPath)];
    Module._load = originalLoad;
  }
});

test('main process installs IPC services once when macOS recreates its window', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const mainPath = path.join(__dirname, '..', 'electron', 'main.js');
  const originalLoad = Module._load;
  const electronMock = createElectronMock();
  const appListeners = new Map();
  const handledChannels = new Set();
  let handleCalls = 0;
  let launchCalls = 0;

  electronMock.app.on = (eventName, listener) => {
    const listeners = appListeners.get(eventName) || [];
    listeners.push(listener);
    appListeners.set(eventName, listeners);
  };
  electronMock.app.whenReady = () => Promise.resolve();
  electronMock.globalShortcut = {
    register: () => true,
    setSuspended() {},
    unregister() {}
  };
  electronMock.Notification = class Notification {
    static isSupported() { return true; }
  };
  electronMock.powerMonitor = {
    on() {},
    removeListener() {},
    getSystemIdleTime: () => 0
  };
  electronMock.ipcMain = {
    handle(channel) {
      handleCalls += 1;
      if (handledChannels.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
      handledChannels.add(channel);
    },
    removeHandler() {}
  };

  Module._load = function loadWithReadyApp(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === './app/bootstrap') {
      return {
        createAppBootstrap() {
          return {
            launchApplication() {
              launchCalls += 1;
              return Promise.resolve();
            }
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(mainPath)];
    require(mainPath);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launchCalls, 1);
    assert.equal(handleCalls, 36);
    assert.deepEqual([...handledChannels].sort(), [
      'desktop-app-icon:get',
      'desktop-app-icon:set-theme',
      'desktop-attention:request',
      'desktop-attention:set-badge-count',
      'desktop-autostart:get-settings',
      'desktop-autostart:set-settings',
      'desktop-call:set-state',
      'desktop-diagnostics:copy-info',
      'desktop-diagnostics:get-info',
      'desktop-diagnostics:open-logs',
      'desktop-diagnostics:set-context',
      'desktop-hotkeys:configure',
      'desktop-hotkeys:set-suspended',
      'desktop-idle:get-system-idle-time',
      'desktop-links:ready',
      'desktop-links:unsubscribe',
      'desktop-load:get',
      'desktop-notifications:show',
      'desktop-overlay:add-game',
      'desktop-overlay:content-size',
      'desktop-overlay:get-foreground',
      'desktop-overlay:get-settings',
      'desktop-overlay:preview',
      'desktop-overlay:ready',
      'desktop-overlay:remove-game',
      'desktop-overlay:set-settings',
      'desktop-overlay:set-snapshot',
      'desktop-overlay:set-suspended',
      'desktop-system:get-state',
      'desktop-update:get-state',
      'desktop-update:install',
      'locale:get',
      'locale:set',
      'window:is-fullscreen',
      'window:reload-main',
      'window:set-fullscreen'
    ]);

    const activate = appListeners.get('activate')?.[0];
    assert.equal(typeof activate, 'function');
    // Activations while a launch is still running join it instead of opening
    // a second window.
    activate();
    activate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launchCalls, 2);

    activate();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launchCalls, 3);
    assert.equal(handleCalls, 36);
  } finally {
    delete require.cache[require.resolve(mainPath)];
    Module._load = originalLoad;
  }
});
