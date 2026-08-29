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

  /**
   * Precedence: URL, then storage, then the browser.
   *
   * ⚠️ The URL has to win, and it did not used to exist at all. Language lived
   * only in localStorage, so there was no address that rendered the Chinese
   * page - a Taiwanese reader could not send a Taiwanese friend a link that
   * opened in Chinese. For a project whose whole origin is "the English version
   * of this material does not exist yet, and it came from Chinese guides", that
   * was backwards.
   *
   * It also has to be a query parameter rather than a hash: a hash is already
   * spoken for by the section anchors, and ?lang= survives being pasted into
   * anything that strips fragments.
   */
  function fromUrl() {
    try {
      var v = new URLSearchParams(location.search).get('lang');
      if (v === 'en' || v === 'zh') return v;
    } catch (e) { /* very old browser; fall through */ }
    return null;
  }

  function pick() {
    var u = fromUrl();
    if (u) return u;
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === 'en' || saved === 'zh') return saved;
    } catch (e) {
      // Private mode, blocked storage, embedded webview. Not a reason to fail.
    }
    return (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  /**
   * ⚠️ `replaceState`, not `pushState`. Toggling language is not navigation, and
   * a history entry per toggle means Back stops meaning "the page I came from"
   * and starts meaning "the same page in the other language" - which is exactly
   * the behaviour that makes people give up and close the tab.
   *
   * The hash is preserved, so a link to a specific Q&A answer survives the
   * switch. That only works because the anchors are slugged from the English.
   */
  function syncUrl(lang) {
    if (!history.replaceState) return;
    try {
      var u = new URL(location.href);
      u.searchParams.set('lang', lang);
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) { /* not fatal; the page still renders the right language */ }
  }

  function apply(lang, updateUrl) {
    root.setAttribute('data-lang', lang);
    root.setAttribute('lang', lang === 'zh' ? 'zh-Hant' : 'en');
    if (updateUrl) syncUrl(lang);
    try { localStorage.setItem(KEY, lang); } catch (e) { /* see above */ }
    var btn = document.querySelector('.langbtn');
    if (btn) {
      btn.textContent = lang === 'zh' ? 'EN' : '中文';
      btn.setAttribute('aria-label',
        lang === 'zh' ? 'Switch to English' : '切換為中文');
    }
  }

  // ⚠️ Only stamp the URL on an explicit toggle, not on load. Rewriting a
  // visitor's clean address the moment they arrive is rude, and it would turn
  // every shared link into a language-pinned one whether they meant that or not.
  apply(pick(), false);

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.langbtn');
    if (!btn) return;
    apply(root.getAttribute('data-lang') === 'zh' ? 'en' : 'zh', true);
  });
})();
