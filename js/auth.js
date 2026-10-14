/*
 * IAS auth helper (shared). Session lives in an HttpOnly cookie set by the server.
 *   const me = await IAS.auth.require();   // redirects to login.html when signed out, change-password.html when required
 *   IAS.auth.can(me, 'app', 'board')       // permission check (role grants + per-user exceptions)
 *   await IAS.auth.logout();
 * The server enforces permissions too. This is only for what the screen shows.
 */
(function (global) {
  const pending = () => new Promise(() => {}); // page is navigating away

  async function me() {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (r.status === 401) return null;
    if (!r.ok) throw new Error('me failed');
    return r.json();
  }

  async function require() {
    const m = await me();
    if (!m) { location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search)); return pending(); }
    if (m.mustChangePassword && !/change-password\.html$/.test(location.pathname)) { location.replace('change-password.html'); return pending(); }
    return m;
  }

  function can(m, kind, id) {
    const p = m && m.permissions && m.permissions[kind];
    return !!p && !p.deny.includes(id) && (p.allow.includes('*') || p.allow.includes(id));
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: '{}' }); } catch (_) {}
    location.replace('login.html');
  }

  global.IAS = global.IAS || {};
  global.IAS.auth = { me, require, can, logout };
})(window);
