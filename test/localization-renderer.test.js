'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const catalog = require('../electron/localization/catalog');

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
