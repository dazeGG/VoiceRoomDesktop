'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

async function main() {
  const outputPath = process.argv[2] || path.join(process.cwd(), 'dist', 'picker-preview.png');

  await app.whenReady();
  const window = new BrowserWindow({
    height: 760,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      sandbox: true
    },
    width: 1040
  });

  await window.loadFile(path.join(__dirname, '..', 'electron', 'ui', 'screen-picker-preview.html'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await window.webContents.capturePage();
  require('node:fs').mkdirSync(path.dirname(outputPath), { recursive: true });
  require('node:fs').writeFileSync(outputPath, image.toPNG());
  window.destroy();
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
