'use strict';

const { app, BrowserWindow, MessageChannelMain } = require('electron');

let completed = false;
let port = null;
let testWindow = null;

const finish = (code, message) => {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  try { port?.close(); } catch {}
  try { testWindow?.destroy(); } catch {}
  (code === 0 ? process.stdout : process.stderr).write(`${message}\n`);
  app.exit(code);
};

const fail = (error) => finish(1, String(error?.stack || error));
const timeout = setTimeout(() => fail(new Error('MessagePortMain frame clone timed out.')), 10000);

app.whenReady().then(async () => {
  // Exercise the production-shaped boundary: MessagePortMain in the Electron
  // process to a DOM MessagePort in a renderer. A hidden window also keeps the
  // Chromium message loop active on Linux CI instead of relying on a
  // windowless main-process-only channel.
  testWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false
    }
  });
  const rendererScript = `
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('message-port', (event) => {
      const [receivedPort] = event.ports || [];
      if (!receivedPort) return;
      receivedPort.onmessage = (messageEvent) => {
        try {
          const data = messageEvent.data?.data;
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
          if (messageEvent.data?.type !== 'frame' || !bytes || bytes.length !== 4 || bytes[3] !== 4) {
            throw new Error('MessagePortMain changed the cloned frame payload.');
          }
          receivedPort.postMessage({ ok: true });
        } catch (error) {
          receivedPort.postMessage({ message: String(error?.stack || error), ok: false });
        }
      };
      receivedPort.start();
    });
  `;
  const page = `<!doctype html><meta charset="utf-8"><script>${rendererScript}<\/script>`;
  await testWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);

  const channel = new MessageChannelMain();
  port = channel.port1;
  port.on('message', (event) => {
    if (event.data?.ok) {
      finish(0, 'message-port-arraybuffer-clone-ok');
    } else {
      fail(new Error(event.data?.message || 'Renderer rejected the cloned frame payload.'));
    }
  });
  port.start();

  testWindow.webContents.postMessage('message-port', null, [channel.port2]);
  const data = Uint8Array.from([1, 2, 3, 4]).buffer;
  port.postMessage({ data, type: 'frame' });
}).catch(fail);
