/*
 * IAS theme. Load in <head> (before the CSS paints) so there is no flash.
 *   'system' -> follow the device (no data-theme),  'light' / 'dark' -> forced via html[data-theme]
 * The choice is saved on the account (PUT /api/me/settings); localStorage only remembers it for the next page load.
 */
(function (global) {
  const KEY = 'ias.theme';
  const apply = (mode) => {
    const r = document.documentElement;
    if (mode === 'light' || mode === 'dark') r.setAttribute('data-theme', mode); else r.removeAttribute('data-theme');
  };
  let mode = 'system';
  try { mode = localStorage.getItem(KEY) || 'system'; } catch (_) { /* private mode */ }
  apply(mode);
  global.IAS = global.IAS || {};
  global.IAS.theme = {
    get: () => mode,
    apply(next) { mode = next; apply(next); try { localStorage.setItem(KEY, next); } catch (_) { /* ignore */ } },
  };
})(window);
