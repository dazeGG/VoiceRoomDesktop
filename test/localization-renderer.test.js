'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const catalog = require('../electron/localization/catalog');

function initializeRenderer({ search = '', bridge } = {}) {
  const label = { dataset: { i18n: 'pickerTitle' }, textContent: '' };
  const document = {
    documentElement: { lang: '' },
    querySelectorAll: (selector) => selector === '[data-i18n]' ? [label] : []
  };
  const window = { voiceRoomCatalog: catalog, location: { search } };
  if (bridge !== undefined) window.voiceRoomLocale = bridge;
  vm.runInNewContext(fs.readFileSync('electron/ui/localization.js', 'utf8'), { document, window, URLSearchParams });
  return { label, document, window };
}

test('native renderer translates explicit labels and ignores a stale initial response after a locale push', async () => {
  const label = { dataset: { i18n: 'pickerTitle' }, textContent: '' };
  const aria = { dataset: { i18nAria: 'close' }, setAttribute: (name, value) => { aria[name] = value; } };
  const document = { documentElement: { lang: 'ru' }, querySelectorAll: (selector) =>
    selector === '[data-i18n]' ? [label] : selector === '[data-i18n-aria]' ? [aria] : [] };
  let push;
  let resolveInitial;
  const window = { voiceRoomCatalog: catalog, location: { search: '?locale=fr' }, voiceRoomLocale: {
    subscribe: (listener) => { push = listener; }, get: () => new Promise((resolve) => { resolveInitial = resolve; })
  } };
  vm.runInNewContext(fs.readFileSync('electron/ui/localization.js', 'utf8'), { document, window, URLSearchParams });
  assert.equal(document.documentElement.lang, 'fr');
  assert.equal(label.textContent, 'Choisissez ce que vous souhaitez partager');
  assert.equal(aria['aria-label'], 'Fermer');
  push('en');
  resolveInitial('ru');
  await Promise.resolve();
  assert.equal(label.textContent, 'Choose what to share');
  assert.equal(document.documentElement.lang, 'en');
  push('de');
  assert.equal(document.documentElement.lang, 'en');
});

test('a rejected initial locale read preserves usable query copy and later pushed updates', async (context) => {
  let rejectInitial;
  let push;
  const unhandled = [];
  const recordUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', recordUnhandled);
  context.after(() => process.removeListener('unhandledRejection', recordUnhandled));
  const { label, document, window } = initializeRenderer({
    search: '?locale=fr',
    bridge: {
      subscribe: (listener) => { push = listener; },
      get: () => new Promise((_resolve, reject) => { rejectInitial = reject; })
    }
  });

  assert.equal(label.textContent, 'Choisissez ce que vous souhaitez partager');
  rejectInitial(new Error('Initial IPC read failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.lang, 'fr');
  assert.equal(label.textContent, 'Choisissez ce que vous souhaitez partager');
  assert.equal(window.voiceRoomI18n.t('close'), 'Fermer');
  assert.deepEqual(unhandled, []);

  push('en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(label.textContent, 'Choose what to share');
  assert.equal(window.voiceRoomI18n.t('close'), 'Close');
});

for (const [search, locale, title] of [
  ['', 'ru', 'Выберите, что показать'],
  ['?locale=de', 'ru', 'Выберите, что показать'],
  ['?locale=fr', 'fr', 'Choisissez ce que vous souhaitez partager'],
  ['?locale=en', 'en', 'Choose what to share']
]) {
  test(`legacy renderer without a locale bridge bootstraps ${search || 'without a query'}`, () => {
    const { label, document, window } = initializeRenderer({ search });
    assert.equal(document.documentElement.lang, locale);
    assert.equal(label.textContent, title);
    assert.equal(window.voiceRoomLocale, undefined);
    assert.equal(typeof window.voiceRoomI18n.t, 'function');
  });
}
