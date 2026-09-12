'use strict';

const MAX_SPELLING_SUGGESTIONS = 5;
// Checked alongside the OS locale so mixed Russian/English chat is not flagged.
const PREFERRED_SPELLCHECK_LANGUAGES = Object.freeze(['ru', 'en-US']);

function isWebLink(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function joinGroups(groups) {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: 'separator' }, ...group]));
}

/**
 * Builds the native context menu for a right click the page did not handle
 * itself (its own menus call preventDefault, so Electron never asks).
 */
function buildContextMenuTemplate(params = {}, actions) {
  const editFlags = params.editFlags || {};
  const groups = [];

  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).slice(0, MAX_SPELLING_SUGGESTIONS);
    groups.push([
      ...(suggestions.length > 0
        ? suggestions.map((suggestion) => ({ click: () => actions.replaceMisspelling(suggestion), label: suggestion }))
        : [{ enabled: false, label: 'Нет вариантов' }]),
      { click: () => actions.addWordToDictionary(params.misspelledWord), label: 'Добавить в словарь' }
    ]);
  }

  if (isWebLink(params.linkURL)) {
    groups.push([{ click: () => actions.writeText(params.linkURL), label: 'Копировать ссылку' }]);
  }

  if (params.mediaType === 'image' && params.hasImageContents) {
    groups.push([{ click: () => actions.copyImageAt(params.x, params.y), label: 'Копировать изображение' }]);
  }

  if (params.isEditable) {
    groups.push([
      { click: actions.cut, enabled: editFlags.canCut === true, label: 'Вырезать' },
      { click: actions.copy, enabled: editFlags.canCopy === true, label: 'Копировать' },
      { click: actions.paste, enabled: editFlags.canPaste === true, label: 'Вставить' }
    ], [
      { click: actions.selectAll, enabled: editFlags.canSelectAll === true, label: 'Выделить всё' }
    ]);
  } else if (typeof params.selectionText === 'string' && params.selectionText.trim()) {
    groups.push([{ click: actions.copy, label: 'Копировать' }]);
  }

  return joinGroups(groups);
}

function resolveSpellCheckerLanguages(current = [], available = []) {
  const supported = new Set(available);
  return [...new Set([...current, ...PREFERRED_SPELLCHECK_LANGUAGES])].filter((language) => supported.has(language));
}

function configureSpellChecker(session, { log = console, platform = process.platform } = {}) {
  // macOS uses the system spellchecker, which picks languages itself.
  if (platform === 'darwin' || !session?.setSpellCheckerLanguages) return;
  try {
    const current = session.getSpellCheckerLanguages();
    const next = resolveSpellCheckerLanguages(current, session.availableSpellCheckerLanguages);
    if (next.length > 0 && next.join() !== current.join()) session.setSpellCheckerLanguages(next);
  } catch (error) {
    log.warn?.('Failed to configure spellchecker languages:', error);
  }
}

function installContextMenu(window, { Menu, clipboard, log = console }) {
  const webContents = window.webContents;
  webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params, {
      addWordToDictionary: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
      copy: () => webContents.copy(),
      copyImageAt: (x, y) => webContents.copyImageAt(x, y),
      cut: () => webContents.cut(),
      paste: () => webContents.paste(),
      replaceMisspelling: (word) => webContents.replaceMisspelling(word),
      selectAll: () => webContents.selectAll(),
      writeText: (text) => clipboard.writeText(text)
    });
    if (template.length === 0 || window.isDestroyed()) return;
    try {
      Menu.buildFromTemplate(template).popup({ window });
    } catch (error) {
      log.warn?.('Failed to show the context menu:', error);
    }
  });
}

module.exports = {
  buildContextMenuTemplate,
  configureSpellChecker,
  installContextMenu,
  resolveSpellCheckerLanguages
};
