/* Language switching for the project pages.
 *
 * Both languages are already in the HTML; this only flips which one CSS shows,
 * remembers the choice, and keeps <html lang> honest for screen readers and
 * search engines.
 *
 * ⚠️ Deliberately NOT a content swap. Rendering one language from JS would
 * leave the other out of the page source and therefore out of search results -
 * and the entire premise of this project is that the English-language version
 * of this material does not exist yet. Hiding it behind a click would be a
 * strange way to fix that.
 */
(function () {
  var KEY = 'lang';
  var root = document.documentElement;

  function pick() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === 'en' || saved === 'zh') return saved;
    } catch (e) {
      // Private mode, blocked storage, embedded webview. Not a reason to fail.
    }
    return (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  function apply(lang) {
    root.setAttribute('data-lang', lang);
    root.setAttribute('lang', lang === 'zh' ? 'zh-Hant' : 'en');
    try { localStorage.setItem(KEY, lang); } catch (e) { /* see above */ }
    var btn = document.querySelector('.langbtn');
    if (btn) {
      btn.textContent = lang === 'zh' ? 'EN' : '中文';
      btn.setAttribute('aria-label',
        lang === 'zh' ? 'Switch to English' : '切換為中文');
    }
  }

  apply(pick());

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.langbtn');
    if (!btn) return;
    apply(root.getAttribute('data-lang') === 'zh' ? 'en' : 'zh');
  });
})();
