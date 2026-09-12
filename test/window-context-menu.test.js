'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
  buildContextMenuTemplate,
  configureSpellChecker,
  installContextMenu,
  resolveSpellCheckerLanguages
} = require('../electron/window/context-menu');

function createActions() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  return {
    actions: {
      addWordToDictionary: record('addWordToDictionary'),
      copy: record('copy'),
      copyImageAt: record('copyImageAt'),
      cut: record('cut'),
      paste: record('paste'),
      replaceMisspelling: record('replaceMisspelling'),
      selectAll: record('selectAll'),
      writeText: record('writeText')
    },
    calls
  };
}

const labels = (template) => template.map((item) => (item.type === 'separator' ? '---' : item.label));

describe('context menu template', () => {
  it('offers spelling suggestions and edit commands in an input', () => {
    const { actions, calls } = createActions();
    const template = buildContextMenuTemplate({
      dictionarySuggestions: ['привет', 'приват', 'a', 'b', 'c', 'd'],
      editFlags: { canCopy: false, canCut: false, canPaste: true, canSelectAll: true },
      isEditable: true,
      misspelledWord: 'превет'
    }, actions);

    assert.deepEqual(labels(template), [
      'привет', 'приват', 'a', 'b', 'c', 'Добавить в словарь', '---',
      'Вырезать', 'Копировать', 'Вставить', '---', 'Выделить всё'
    ]);
    assert.deepEqual(template.filter((item) => item.enabled === false).map((item) => item.label), ['Вырезать', 'Копировать']);

    template[0].click();
    template[5].click();
    template.find((item) => item.label === 'Вставить').click();
    assert.deepEqual(calls, [['replaceMisspelling', 'привет'], ['addWordToDictionary', 'превет'], ['paste']]);
  });

  it('shows a disabled placeholder when the spellchecker has no suggestions', () => {
    const { actions } = createActions();
    const template = buildContextMenuTemplate({ editFlags: {}, isEditable: true, misspelledWord: 'qwzx' }, actions);

    assert.equal(template[0].label, 'Нет вариантов');
    assert.equal(template[0].enabled, false);
  });

  it('copies links, images and selected text outside inputs', () => {
    const { actions, calls } = createActions();
    const template = buildContextMenuTemplate({
      hasImageContents: true,
      linkURL: 'https://example.com/a',
      mediaType: 'image',
      selectionText: 'hello',
      x: 10,
      y: 20
    }, actions);

    assert.deepEqual(labels(template), ['Копировать ссылку', '---', 'Копировать изображение', '---', 'Копировать']);
    template[0].click();
    template[2].click();
    template[4].click();
    assert.deepEqual(calls, [['writeText', 'https://example.com/a'], ['copyImageAt', 10, 20], ['copy']]);
  });

  it('stays empty for a plain click and ignores non-web links', () => {
    const { actions } = createActions();
    assert.deepEqual(buildContextMenuTemplate({ selectionText: '   ' }, actions), []);
    assert.deepEqual(buildContextMenuTemplate({ linkURL: 'javascript:alert(1)' }, actions), []);
    assert.deepEqual(buildContextMenuTemplate(undefined, actions), []);
  });
});

describe('context menu installation', () => {
  function createWindow() {
    const webContents = new EventEmitter();
    webContents.copy = () => {};
    return { isDestroyed: () => false, webContents };
  }

  it('pops the menu over the window only when it has items', () => {
    const window = createWindow();
    const popups = [];
    const Menu = {
      buildFromTemplate: (template) => ({ popup: (options) => popups.push({ options, template }) })
    };
    installContextMenu(window, { Menu, clipboard: { writeText() {} }, log: { warn() {} } });

    window.webContents.emit('context-menu', {}, { selectionText: '' });
    assert.equal(popups.length, 0);

    window.webContents.emit('context-menu', {}, { selectionText: 'hi' });
    assert.equal(popups.length, 1);
    assert.equal(popups[0].options.window, window);
    assert.deepEqual(labels(popups[0].template), ['Копировать']);
  });
});

describe('spellchecker languages', () => {
  it('adds Russian and English to the OS locale when available', () => {
    assert.deepEqual(resolveSpellCheckerLanguages(['de'], ['de', 'en-US', 'ru']), ['de', 'ru', 'en-US']);
    assert.deepEqual(resolveSpellCheckerLanguages(['ru'], ['ru', 'en-US']), ['ru', 'en-US']);
    assert.deepEqual(resolveSpellCheckerLanguages([], ['en-US']), ['en-US']);
    assert.deepEqual(resolveSpellCheckerLanguages(['xx'], []), []);
  });

  function createSession(current, available) {
    const session = {
      availableSpellCheckerLanguages: available,
      getSpellCheckerLanguages: () => current,
      set: [],
      setSpellCheckerLanguages: (languages) => session.set.push(languages)
    };
    return session;
  }

  it('updates the session only when the list changes and never on macOS', () => {
    const changed = createSession(['ru'], ['ru', 'en-US']);
    configureSpellChecker(changed, { platform: 'win32' });
    assert.deepEqual(changed.set, [['ru', 'en-US']]);

    const unchanged = createSession(['ru', 'en-US'], ['ru', 'en-US']);
    configureSpellChecker(unchanged, { platform: 'win32' });
    assert.deepEqual(unchanged.set, []);

    const mac = createSession(['ru'], ['ru', 'en-US']);
    configureSpellChecker(mac, { platform: 'darwin' });
    assert.deepEqual(mac.set, []);
  });
});
