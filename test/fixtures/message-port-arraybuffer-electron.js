'use strict';

const { app, MessageChannelMain } = require('electron');

const fail = (error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  app.exit(1);
};

const timeout = setTimeout(() => fail(new Error('MessagePortMain frame clone timed out.')), 5000);

app.whenReady().then(() => {
  const { port1, port2 } = new MessageChannelMain();
  port2.on('message', (event) => {
    try {
      const data = event.data?.data;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
      if (event.data?.type !== 'frame' || !bytes || bytes.length !== 4 || bytes[3] !== 4) {
        throw new Error('MessagePortMain changed the cloned frame payload.');
      }
      clearTimeout(timeout);
      port1.close();
      port2.close();
      process.stdout.write('message-port-arraybuffer-clone-ok\n');
      app.exit(0);
    } catch (error) {
      fail(error);
    }
  });
  port2.start();

  const data = Uint8Array.from([1, 2, 3, 4]).buffer;
  port1.postMessage({ data, type: 'frame' });
}).catch(fail);
