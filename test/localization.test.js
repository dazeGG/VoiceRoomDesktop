'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { catalogs, resolveLocale, translate } = require('../electron/localization/catalog');
const { createLocaleController } = require('../electron/localization');

test('all catalogs have the same keys and named interpolation arguments', () => {
  const keys = Object.keys(catalogs.ru).sort();
  for (const language of ['en', 'fr']) {
    assert.deepEqual(Object.keys(catalogs[language]).sort(), keys);
    for (const key of keys) {
      const args = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(args(catalogs[language][key]), args(catalogs.ru[key]), `${language}:${key}`);
    }
  }
  assert.equal(translate('fr', 'preview', { name: '<window>' }), 'Aperçu : <window>');
});

test('first supported preference wins and unsupported languages fall back to Russian', () => {
  assert.equal(resolveLocale(['de-DE', 'fr-CA', 'en-GB']), 'fr');
  assert.equal(resolveLocale(['EN-gb']), 'en');
  assert.equal(resolveLocale(['de']), 'ru');
});

function fixture(saved = {}, failWrite = false) {
  let data = { ...saved };
  const handlers = new Map();
  const pushed = [];
  const controller = createLocaleController({
    app: { getPreferredSystemLanguages: () => ['fr-CA'] },
    settingsStore: { read: () => data, patch: (next) => { if (failWrite) throw new Error('disk'); data = { ...data, ...next }; } },
    getWindows: () => [{ webContents: { send: (...args) => pushed.push(args) } }],
    isTrustedFrame: (frame) => frame?.url === 'https://voiceroom.test/app',
    log: { warn() {} }
  });
  controller.configureIpc({ handle: (name, handler) => handlers.set(name, handler) });
  return { controller, handlers, pushed, data: () => data };
}

test('saved locale wins, changes persist before broadcast and survive initialization', () => {
  const f = fixture({ locale: 'en', other: true });
  assert.equal(f.controller.initialize(), 'en');
  let observed;
  const off = f.controller.subscribe((next) => { observed = [next, f.data().locale]; });
  assert.equal(f.controller.set('fr'), 'fr');
  assert.deepEqual(observed, ['fr', 'fr']);
  assert.deepEqual(f.pushed, [['locale:changed', 'fr']]);
  assert.equal(f.data().other, true);
  off();
  assert.equal(f.controller.initialize(), 'fr');
});

test('failed durable save retains current language and emits no change', () => {
  const f = fixture({ locale: 'ru' }, true);
  f.controller.initialize();
  assert.throws(() => f.controller.set('en'), /disk/);
  assert.equal(f.controller.get(), 'ru');
  assert.deepEqual(f.pushed, []);
});

test('invalid language and untrusted frames cannot mutate the saved locale', () => {
  const f = fixture({ locale: 'ru' });
  f.controller.initialize();
  const get = f.handlers.get('locale:get');
  const set = f.handlers.get('locale:set');
  assert.throws(() => get({ senderFrame: { url: 'https://evil.test' } }), /Untrusted/);
  assert.throws(() => set({ senderFrame: { url: 'https://evil.test' } }, 'en'), /Untrusted/);
  assert.throws(() => set({ senderFrame: { url: 'https://voiceroom.test/app' } }, 'de'), /Unsupported/);
  assert.equal(set({ senderFrame: { url: 'https://voiceroom.test/app' } }, 'en'), 'en');
});

test('native call and macOS menu labels follow the saved language without changing actions', () => {
  const { describeCallControls } = require('../electron/call-controls');
  const { configureMacApplicationMenu } = require('../electron/window/menu-policy');
  const f = fixture({ locale: 'fr' });
  f.controller.initialize();
  assert.deepEqual(describeCallControls({ active: true, micMuted: true }).map(({ action, label }) => [action, label]), [
    ['toggle-mic', 'Activer le microphone'], ['toggle-output', 'Couper le son'], ['disconnect', 'Se déconnecter']
  ]);
  let menu;
  configureMacApplicationMenu({ platform: 'darwin', menu: {
    buildFromTemplate: (items) => items, setApplicationMenu: (items) => { menu = items; }
  } });
  assert.equal(menu[2].label, 'Édition');
  assert.equal(menu[2].submenu[3].role, 'cut');
  assert.equal(menu[2].submenu[3].label, 'Couper');
});

test('only exact app-owned native main frames may read locale', () => {
  const { pathToFileURL } = require('node:url');
  const path = require('node:path');
  const f = fixture({ locale: 'en' });
  f.controller.initialize();
  const frame = { url: pathToFileURL(path.join(__dirname, '../electron/ui/renderer-recovery.html')).href + '?locale=fr' };
  const get = f.handlers.get('locale:get');
  assert.equal(get({ senderFrame: frame, sender: { mainFrame: frame } }), 'en');
  assert.throws(() => get({ senderFrame: frame, sender: { mainFrame: {} } }), /Untrusted/);
  assert.throws(() => f.handlers.get('locale:set')({ senderFrame: frame, sender: { mainFrame: frame } }, 'fr'), /Untrusted/);
});
