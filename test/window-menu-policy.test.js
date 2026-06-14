'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { disableWindowsApplicationMenu } = require('../electron/window/menu-policy');

test('disables the application menu on Windows', () => {
  const calls = [];
  const disabled = disableWindowsApplicationMenu({
    platform: 'win32',
    menu: {
      setApplicationMenu(value) {
        calls.push(value);
      }
    }
  });

  assert.equal(disabled, true);
  assert.deepEqual(calls, [null]);
});

test('does not change the application menu on non-Windows platforms', () => {
  for (const platform of ['darwin', 'linux']) {
    const calls = [];
    const disabled = disableWindowsApplicationMenu({
      platform,
      menu: {
        setApplicationMenu(value) {
          calls.push(value);
        }
      }
    });

    assert.equal(disabled, false);
    assert.deepEqual(calls, []);
  }
});

test('fails closed when the menu module is unavailable', () => {
  assert.equal(disableWindowsApplicationMenu({ platform: 'win32', menu: null }), false);
  assert.equal(disableWindowsApplicationMenu({ platform: 'win32', menu: {} }), false);
});

test('main process wires the Electron Menu module into the Windows menu policy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

  assert.match(mainSource, /disableWindowsApplicationMenu\(\{ menu: Menu \}\);/);
});
