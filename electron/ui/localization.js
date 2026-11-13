'use strict';

(function initializeLanguage() {
  const catalog = window.voiceRoomCatalog;
  const initial = new URLSearchParams(window.location.search).get('locale');
  let locale = catalog.isLocale(initial) ? initial : 'ru';
  let pushed = false;
  const listeners = new Set();

  function t(key, values) { return catalog.translate(locale, key, values); }

  function apply() {
    document.documentElement.lang = locale;
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
    for (const node of document.querySelectorAll('[data-i18n-title]')) node.setAttribute('title', t(node.dataset.i18nTitle));
    for (const listener of listeners) listener(locale);
  }

  function change(next) {
    if (!catalog.isLocale(next)) return;
    locale = next;
    apply();
  }

  window.voiceRoomI18n = { t, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  window.voiceRoomLocale?.subscribe?.((next) => { pushed = true; change(next); });
  apply();
  window.voiceRoomLocale?.get?.().then((next) => { if (!pushed) change(next); }).catch(() => {});
})();
