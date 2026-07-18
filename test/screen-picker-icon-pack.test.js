'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { describe, it } = require('node:test');

const packageJson = require('../package.json');
const html = fs.readFileSync('electron/ui/screen-picker-preview.html', 'utf8');
const iconRuntime = fs.readFileSync('electron/ui/screen-picker-icons.js', 'utf8');
const pickerRuntime = fs.readFileSync('electron/ui/screen-picker.js', 'utf8');

describe('screen picker Lucide icon contract', () => {
  it('uses the web app Lucide version instead of handwritten SVG icons', () => {
    assert.equal(packageJson.dependencies.lucide, '1.24.0');
    assert.doesNotMatch(html, /<svg\b/);
    for (const icon of ['app-window', 'monitor', 'play', 'settings', 'type', 'x']) {
      assert.match(html, new RegExp(`data-lucide="${icon}"`));
    }
  });

  it('loads Lucide and the shared picker icon runtime before picker behavior', () => {
    const lucideIndex = html.indexOf('node_modules/lucide/dist/umd/lucide.min.js');
    const iconsIndex = html.indexOf('./screen-picker-icons.js');
    const pickerIndex = html.indexOf('./screen-picker.js');

    assert.ok(lucideIndex >= 0 && iconsIndex > lucideIndex && pickerIndex > iconsIndex);
    assert.match(iconRuntime, /strokeWidth:\s*2/);
    assert.match(iconRuntime, /sm:\s*15/);
    assert.match(iconRuntime, /md:\s*18/);
  });

  it('matches web picker source icons and selected-state checkmark', () => {
    assert.match(pickerRuntime, /source\.appIcon/);
    assert.match(pickerRuntime, /createLucidePlaceholder\('check', 'xs'\)/);
    assert.match(pickerRuntime, /source\.type === 'screen' \? 'monitor' : 'app-window'/);
  });
});
