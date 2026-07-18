'use strict';

const { app, BrowserWindow, ipcMain, MessageChannelMain } = require('electron');
const http = require('node:http');
const path = require('node:path');

const {
  NATIVE_CAPTURE_PROTOCOL_VERSION
} = require('../../electron/native/capture-contract');
const {
  getNativeCaptureInjectScript
} = require('../../electron/policies/native-capture');

let completed = false;
let server = null;
let testWindow = null;
const sessions = [];

const finish = (code, message) => {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  for (const session of sessions) {
    try { session.port.close(); } catch {}
  }
  try { testWindow?.destroy(); } catch {}
  try { server?.close(); } catch {}
  const output = code === 0 ? process.stdout : process.stderr;
  output.write(`${message}\n`, () => app.exit(code));
};

const fail = (error) => finish(1, String(error?.stack || error));
const timeout = setTimeout(() => fail(new Error('Production native-capture bridge timed out.')), 12000);

function createFrame(format) {
  if (format === 'NV12') {
    return {
      data: Uint8Array.from([16, 16, 16, 16, 128, 128]).buffer,
      format,
      height: 2,
      timestampMs: 2000,
      type: 'frame',
      width: 2
    };
  }

  return {
    data: Uint8Array.from([
      0, 0, 255, 255,
      0, 255, 0, 255,
      255, 0, 0, 255,
      255, 255, 255, 255
    ]).buffer,
    format: 'BGRX',
    height: 2,
    timestampMs: 1000,
    type: 'frame',
    width: 2
  };
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin'
      });
      response.end('<!doctype html><html><body>native capture smoke</body></html>');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function waitForAck(session) {
  return Promise.race([
    session.ack,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${session.format} frame was not acknowledged.`)), 3000);
    })
  ]);
}

app.whenReady().then(async () => {
  const fixtureUrl = await startServer();
  const formats = ['BGRX', 'NV12'];
  let prepareCalls = 0;
  let fallbackStartCalls = 0;

  ipcMain.handle('desktop-audio:ensure-media-access', () => {
    throw new Error('Media warm-up is intentionally disabled in this fixture.');
  });
  ipcMain.handle('native-capture:commit-prepared', () => true);
  ipcMain.handle('native-capture:start', () => {
    fallbackStartCalls += 1;
    return { ok: false, reason: 'unexpected-fallback' };
  });
  ipcMain.handle('native-capture:stop', () => true);
  ipcMain.handle('native-capture:prepare', (event) => {
    const format = formats[prepareCalls];
    if (!format) return { ok: false, reason: 'fixture-exhausted' };

    prepareCalls += 1;
    const sessionId = `fixture-${prepareCalls}`;
    const channel = new MessageChannelMain();
    let resolveAck = null;
    const ack = new Promise((resolve) => { resolveAck = resolve; });
    const session = {
      ack,
      format,
      port: channel.port1,
      sessionId
    };
    sessions.push(session);
    channel.port1.on('message', (messageEvent) => {
      if (messageEvent.data?.type === 'frame-ack') resolveAck();
    });
    channel.port1.start();

    // Match electron/native/capture.js: the invoke result reaches the main
    // world before preload forwards the transferred port on the next turn.
    setImmediate(() => {
      event.sender.postMessage('native-capture:port', {
        protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
        sessionId
      }, [channel.port2]);
      channel.port1.postMessage({
        fps: 30,
        height: 2,
        pixelFormat: format,
        type: 'format',
        width: 2
      });
      channel.port1.postMessage(createFrame(format));
    });

    return {
      fps: 30,
      maxHeight: 2,
      maxWidth: 2,
      ok: true,
      protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
      qualityId: 'high',
      sessionId,
      sourceId: 'screen:1:0'
    };
  });

  // Use the production renderer security posture and the real production
  // preload. The Linux child may still carry --no-sandbox because hosted
  // runners cannot install Electron's setuid chrome-sandbox correctly.
  testWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '..', '..', 'electron', 'preload.js'),
      sandbox: true
    }
  });
  await testWindow.loadURL(fixtureUrl);
  await testWindow.webContents.executeJavaScript(getNativeCaptureInjectScript(), true);

  const rendererResult = await testWindow.webContents.executeJavaScript(`(async () => {
    if (!window.voiceRoomNativeCaptureBridge?.prepare) {
      throw new Error('Production preload did not expose the native capture bridge.');
    }
    if (!window.__voiceRoomNativeCaptureInstalled) {
      throw new Error('Production native capture policy was not installed.');
    }

    const formats = [];
    for (const expectedFormat of ['BGRX', 'NV12']) {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const [track] = stream.getVideoTracks();
      const stats = window.__voiceRoomNativeCaptureStats?.();
      if (!(stream instanceof MediaStream) || !track || track.kind !== 'video') {
        throw new Error(expectedFormat + ' did not produce a real video MediaStreamTrack.');
      }
      if (stats?.pixelFormat !== expectedFormat || stats.framesReceived !== 1 || stats.framesWritten !== 1) {
        throw new Error(expectedFormat + ' did not complete its real VideoFrame/generator write: ' + JSON.stringify(stats));
      }
      formats.push(stats.pixelFormat);
      track.stop();
    }
    return { formats };
  })()`, true);

  await Promise.all(sessions.map(waitForAck));
  if (prepareCalls !== 2 || fallbackStartCalls !== 0) {
    throw new Error(`Unexpected native bridge calls: prepare=${prepareCalls}, start=${fallbackStartCalls}`);
  }
  if (rendererResult.formats.join(',') !== 'BGRX,NV12') {
    throw new Error(`Unexpected renderer formats: ${rendererResult.formats.join(',')}`);
  }

  finish(0, `production-native-capture-bridge-ok ${rendererResult.formats.join(',')}`);
}).catch(fail);
