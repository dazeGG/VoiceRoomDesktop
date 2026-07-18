'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const lucide = require('lucide');
const packageJson = require('../package.json');
const html = fs.readFileSync('electron/ui/screen-picker-preview.html', 'utf8');
const iconRuntime = fs.readFileSync('electron/ui/screen-picker-icons.js', 'utf8');
const pickerRuntime = fs.readFileSync('electron/ui/screen-picker.js', 'utf8');

function createSvg(dataset) {
  const attributes = new Map();

  return {
    dataset,
    getAttribute(name) {
      return attributes.get(name);
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    }
  };
}

function createRoot(svgNodes) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, 'svg[data-icon-size]');
      return svgNodes;
    }
  };
}

function executeIconRuntime(svgNodes = []) {
  const createIconsCalls = [];
  const context = {
    document: createRoot(svgNodes),
    window: {
      lucide: {
        createIcons(options) {
          createIconsCalls.push(options);
        },
        icons: lucide.icons
      }
    }
  };

  vm.runInNewContext(iconRuntime, context, { filename: 'screen-picker-icons.js' });
  return { context, createIconsCalls };
}

function executeIconRuntimeWithoutLucide() {
  const context = {
    document: createRoot([]),
    window: {}
  };

  vm.runInNewContext(iconRuntime, context, { filename: 'screen-picker-icons.js' });
  return context;
}

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

  it('supplies the exact picker icon set and stroke width at runtime', () => {
    const { createIconsCalls } = executeIconRuntime();

    assert.equal(createIconsCalls.length, 1);
    assert.equal(createIconsCalls[0].attrs['stroke-width'], 2);
    assert.deepEqual(Object.keys(createIconsCalls[0].icons), [
      'AppWindow',
      'Check',
      'Monitor',
      'Play',
      'Settings',
      'Type',
      'X'
    ]);
    for (const [name, icon] of Object.entries(createIconsCalls[0].icons)) {
      assert.equal(icon, lucide.icons[name]);
    }
  });

  it('sets expected icon dimensions and fill behavior at runtime', () => {
    const icons = [
      createSvg({ iconSize: 'xs' }),
      createSvg({ iconSize: 'sm' }),
      createSvg({ iconSize: 'md', iconFill: 'true' }),
      createSvg({ iconSize: 'lg' })
    ];

    executeIconRuntime(icons);

    assert.deepEqual(
      icons.map((icon) => [icon.getAttribute('width'), icon.getAttribute('height')]),
      [['12', '12'], ['15', '15'], ['18', '18'], ['20', '20']]
    );
    assert.equal(icons[2].getAttribute('fill'), 'currentColor');
    assert.equal(icons[0].getAttribute('fill'), undefined);
  });

  it('renders picker icons for a supplied root', () => {
    const { context, createIconsCalls } = executeIconRuntime();
    const icon = createSvg({ iconSize: 'lg', iconFill: 'true' });
    const root = createRoot([icon]);

    const rendered = context.window.voiceRoomPickerIcons.render(root);

    assert.equal(rendered, true);
    assert.equal(createIconsCalls.length, 2);
    assert.equal(createIconsCalls[1].root, root);
    assert.equal(icon.getAttribute('width'), '20');
    assert.equal(icon.getAttribute('height'), '20');
    assert.equal(icon.getAttribute('fill'), 'currentColor');
  });

  it('loads and no-ops safely when Lucide is unavailable at runtime', () => {
    const context = executeIconRuntimeWithoutLucide();

    assert.equal(typeof context.window.voiceRoomPickerIcons.render, 'function');
    assert.equal(context.window.voiceRoomPickerIcons.strokeWidth, 2);
    assert.deepEqual(Object.entries(context.window.voiceRoomPickerIcons.sizes), [
      ['lg', 20],
      ['md', 18],
      ['sm', 15],
      ['xs', 12]
    ]);
    assert.doesNotThrow(() => {
      assert.equal(context.window.voiceRoomPickerIcons.render(createRoot([])), false);
    });
  });

  it('no-ops safely when the Lucide runtime is malformed', () => {
    for (const lucideRuntime of [{}, { createIcons() {} }, { icons: lucide.icons }, { createIcons() {}, icons: {} }]) {
      const context = {
        document: createRoot([]),
        window: { lucide: lucideRuntime }
      };

      assert.doesNotThrow(() => vm.runInNewContext(iconRuntime, context, { filename: 'screen-picker-icons.js' }));
      assert.equal(context.window.voiceRoomPickerIcons.render(createRoot([])), false);
    }
  });
});
