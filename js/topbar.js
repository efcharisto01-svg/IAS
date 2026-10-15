/*
 * IAS shared top bar: title, notification bell, profile avatar (css: .topbar, .ibtn, .badge, .avatar, .notif-*)
 *   const me = await IAS.auth.require();
 *   IAS.topbar.mount({ title: '홈', me });
 *
 * - Bell: unread count badge. Panel: "전체 N건 · 안 읽음 M건". Clicking a notification marks it read and opens its page.
 * - Avatar: opens the profile panel (js/profile.js): my info, photo, notification / screen settings, devices, logout.
 * - Clicking anywhere outside an open panel closes it.
 * - The server is asked every 30 seconds (paused while the tab is hidden). The server hides
 *   notifications from apps the user may not use and deletes the ones older than 60 days.
 * - Device notifications (Web Push) are switched on in the profile: 알림 설정. js/push.js and sw.js must be served.
 */
(function (global) {
  const POLL_MS = 30000;
  const SAFE_LINK = /^\/?[\w.-]+\.html(\?[\w=&%.\-]*)?(#[\w-]*)?$/;
  const PALETTE = ['#0a84ff', '#ff9f0a', '#30b0c7', '#bf5af2', '#34c759', '#ff6482', '#64d2ff', '#a2845e'];
  const SYSTEM_COLOR = '#636366';

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const colorFor = (source) => {
    if (source === '시스템') return SYSTEM_COLOR;
    let h = 0; for (const ch of source) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };
  function ago(sec) {
    const m = Math.max(0, Math.floor((Date.now() / 1000 - sec) / 60));
    if (m < 1) return '방금';
    if (m < 60) return m + '분 전';
    if (m < 1440) return Math.floor(m / 60) + '시간 전';
    return Math.floor(m / 1440) + '일 전';
  }
  function dayGroup(sec) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const t = start.getTime() / 1000;
    return sec >= t ? '오늘' : sec >= t - 86400 ? '어제' : '이전';
  }
  const post = (path) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: '{}', keepalive: true });

  function mount({ title = '', me } = {}) {
    document.body.classList.add('has-topbar');
    if (me && me.settings && global.IAS.theme) global.IAS.theme.apply(me.settings.theme); // account theme wins over this device's cache

    const bar = el('header', 'topbar');
    bar.appendChild(el('div', 'topbar-title', title));
    const tools = el('div', 'topbar-tools');
    const bell = el('button', 'ibtn bell');
    bell.type = 'button'; bell.setAttribute('aria-label', '알림'); bell.setAttribute('aria-haspopup', 'dialog'); bell.setAttribute('aria-expanded', 'false'); bell.setAttribute('aria-controls', 'notifPanel');
    bell.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
    const badge = el('span', 'badge', '0'); badge.hidden = true; bell.appendChild(badge);
    tools.appendChild(bell);
    const avatar = el('button', 'avatar'); avatar.type = 'button';
    avatar.setAttribute('aria-label', '프로필'); avatar.setAttribute('aria-haspopup', 'dialog'); avatar.setAttribute('aria-expanded', 'false'); avatar.setAttribute('aria-controls', 'profilePanel');
    tools.appendChild(avatar);
    bar.appendChild(tools);

    const scrim = el('div', 'scrim');
    const panel = el('section', 'notif-panel'); panel.id = 'notifPanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '알림');
    const head = el('div', 'notif-head'); const hl = el('div'); hl.appendChild(el('h2', null, '알림'));
    const sum = el('div', 'notif-sum'); hl.appendChild(sum); head.appendChild(hl);
    const allBtn = el('button', 'notif-all', '모두 읽음'); allBtn.type = 'button'; head.appendChild(allBtn);
    const tabs = el('div', 'notif-tabs');
    const tAll = el('button', 'notif-tab'); const tUn = el('button', 'notif-tab');
    [tAll, tUn].forEach((t) => { t.type = 'button'; tabs.appendChild(t); });
    const list = el('div', 'notif-list');
    const foot = el('div', 'notif-foot', '최근 60일 알림만 보관됩니다');
    [head, tabs, list, foot].forEach((n) => panel.appendChild(n));
    document.body.append(bar, scrim, panel);

    let data = { total: 0, unread: 0, items: [] }, filter = 'all', loaded = false, timer = null, destroyed = false;

    // profile panel (photo, my info, settings, devices, logout)
    const profile = me && global.IAS.profile ? global.IAS.profile.attach({ me, button: avatar, scrim }) : null;
    if (!profile) avatar.textContent = me && me.user ? me.user.name.charAt(0) : '';

    function render() {
      const { total, unread, items } = data;
      badge.hidden = unread === 0; badge.textContent = unread > 99 ? '99+' : String(unread);
      bell.setAttribute('aria-label', `알림 ${total}건, 안 읽음 ${unread}건`);
      sum.textContent = `전체 ${total}건 · `; sum.appendChild(el('b', null, `안 읽음 ${unread}건`));
      tAll.textContent = `전체 ${total}`; tUn.textContent = `안 읽음 ${unread}`;
      tAll.setAttribute('aria-pressed', String(filter === 'all')); tUn.setAttribute('aria-pressed', String(filter === 'unread'));
      allBtn.disabled = unread === 0;
      list.textContent = '';
      const rows = items.filter((n) => filter === 'all' || !n.read);
      if (!rows.length) { list.appendChild(el('div', 'notif-empty', filter === 'unread' ? '안 읽은 알림이 없습니다' : '알림이 없습니다')); return; }
      let last = '';
      rows.forEach((n) => {
        const g = dayGroup(n.createdAt);
        if (g !== last) { list.appendChild(el('div', 'notif-group', g)); last = g; }
        const b = el('button', 'notif-item' + (n.read ? '' : ' unread')); b.type = 'button';
        const ic = el('span', 'notif-ic', n.source.charAt(0)); ic.style.background = colorFor(n.source);
        b.append(ic, el('span', 'notif-title', n.title), el('span', 'notif-time', ago(n.createdAt)), el('span', 'notif-body', n.source + (n.body ? ' · ' + n.body : '')));
        b.addEventListener('click', () => open_(n));
        list.appendChild(b);
      });
    }

    function open_(n) {
      if (!n.read) { n.read = true; data.unread = Math.max(0, data.unread - 1); post(`/api/notifications/${n.id}/read`).catch(() => {}); }
      render();
      if (n.link && SAFE_LINK.test(n.link)) location.href = n.link.replace(/^\//, '');
    }

    async function refresh() {
      if (destroyed) return;
      try {
        const r = await fetch('/api/notifications?limit=50', { credentials: 'same-origin' });
        if (r.status === 401) { location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search)); return; }
        if (!r.ok) return;
        const next = await r.json();
        const grew = loaded && next.unread > data.unread;
        data = next; loaded = true; render();
        if (grew) { badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop'); bell.classList.remove('ring'); void bell.offsetWidth; bell.classList.add('ring'); }
      } catch (_) { /* offline: try again on the next tick */ }
    }

    function setOpen(on) {
      panel.classList.toggle('on', on); scrim.classList.toggle('on', on); bell.setAttribute('aria-expanded', String(on));
      if (on) refresh();
    }
    bell.addEventListener('click', () => setOpen(!panel.classList.contains('on')));
    scrim.addEventListener('click', () => { setOpen(false); if (profile) profile.close(); });
    const onKey = (e) => { if (e.key === 'Escape' && panel.classList.contains('on')) { setOpen(false); bell.focus(); } };
    document.addEventListener('keydown', onKey);
    // click anywhere outside the panel (and not on the bell itself) closes it
    const onDown = (e) => { if (panel.classList.contains('on') && !panel.contains(e.target) && !bell.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    [[tAll, 'all'], [tUn, 'unread']].forEach(([t, f]) => t.addEventListener('click', () => { filter = f; render(); }));
    allBtn.addEventListener('click', () => {
      data.items.forEach((n) => { n.read = true; }); data.unread = 0; render();
      post('/api/notifications/read-all').catch(() => {});
    });

    const start = () => { if (!timer) timer = setInterval(refresh, POLL_MS); };
    const stop = () => { clearInterval(timer); timer = null; };
    const onVis = () => { if (document.hidden) stop(); else { refresh(); start(); } };
    document.addEventListener('visibilitychange', onVis);
    render(); refresh(); if (!document.hidden) start();
    if (global.IAS.push) { global.IAS.push.register().then(() => global.IAS.push.sync()); global.IAS.push.onMessage(refresh); }

    return {
      refresh,
      destroy() {
        destroyed = true; stop(); document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('visibilitychange', onVis);
        if (profile) profile.destroy(); bar.remove(); scrim.remove(); panel.remove(); document.body.classList.remove('has-topbar');
      },
    };
  }

  global.IAS = global.IAS || {};
  global.IAS.topbar = { mount };
})(window);
