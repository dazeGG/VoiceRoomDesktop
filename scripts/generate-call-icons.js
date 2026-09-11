'use strict';

// Renders the call-control icons (tray "in call" badge and taskbar toolbar
// glyphs) into assets/call. Run with `npm run icons:call` after changing the
// logo or the lucide version; the PNGs are committed.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const lucide = require('lucide');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'call');
const LOGO_SVG_PATH = path.join(__dirname, '..', 'assets', 'logo', 'icon.svg');
const BASE_SIZE = 16;
const SCALES = [1, 2];
const GLYPH_COLORS = { dark: '#1e1f22', light: '#f2f3f5' };
const ALERT_COLOR = '#f23f43';
const IN_CALL_DOT_COLOR = '#23a55a';
const GLYPHS = [
  { name: 'mic', icon: 'Mic', alert: false },
  { name: 'mic-off', icon: 'MicOff', alert: true },
  { name: 'headphones', icon: 'Headphones', alert: false },
  { name: 'headphone-off', icon: 'HeadphoneOff', alert: true },
  { name: 'phone-off', icon: 'PhoneOff', alert: true }
];

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function lucideSvg(iconName, color) {
  const node = lucide[iconName];
  if (!Array.isArray(node)) throw new Error(`Unknown lucide icon: ${iconName}`);
  const children = node.map(([tag, attrs]) => {
    const attributes = Object.entries(attrs).map(([key, value]) => `${key}="${escapeAttribute(value)}"`).join(' ');
    return `<${tag} ${attributes}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}

function outputName(base, scale) {
  return scale === 1 ? `${base}.png` : `${base}@${scale}x.png`;
}

async function renderPng(window, svg, size, { dot = false } = {}) {
  const dataUrl = await window.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(svg)};
    const size = ${size};
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, size, size);
    URL.revokeObjectURL(url);
    if (${dot}) {
      const radius = size * 0.24;
      const center = size - radius - size * 0.02;
      context.globalCompositeOperation = 'destination-out';
      context.beginPath();
      context.arc(center, center, radius + size * 0.08, 0, Math.PI * 2);
      context.fill();
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = ${JSON.stringify(IN_CALL_DOT_COLOR)};
      context.beginPath();
      context.arc(center, center, radius, 0, Math.PI * 2);
      context.fill();
    }
    return canvas.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    height: 64,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, sandbox: true },
    width: 64
  });
  await window.loadURL('data:text/html,<!doctype html><title>icons</title>');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const written = [];
  const write = (fileName, buffer) => {
    fs.writeFileSync(path.join(OUTPUT_DIR, fileName), buffer);
    written.push(fileName);
  };

  const logoSvg = fs.readFileSync(LOGO_SVG_PATH, 'utf8');
  for (const scale of SCALES) {
    write(outputName('tray-in-call', scale), await renderPng(window, logoSvg, BASE_SIZE * scale, { dot: true }));
  }

  for (const glyph of GLYPHS) {
    for (const [variant, glyphColor] of Object.entries(GLYPH_COLORS)) {
      const svg = lucideSvg(glyph.icon, glyph.alert ? ALERT_COLOR : glyphColor);
      for (const scale of SCALES) {
        write(outputName(`${glyph.name}-${variant}`, scale), await renderPng(window, svg, BASE_SIZE * scale));
      }
    }
  }

  window.destroy();
  console.log(`Wrote ${written.length} icons to ${path.relative(process.cwd(), OUTPUT_DIR)}`);
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
