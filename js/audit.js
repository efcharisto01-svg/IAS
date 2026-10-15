/*
 * 감사 로그 화면 (회사 관리자 전용). GET /api/admin/audit, /api/admin/audit.csv
 * The server decides who may read it ('audit' permission) and which company's rows are returned.
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const me = await IAS.auth.require();
  IAS.topbar.mount({ title: '감사 로그', me });
  if (!IAS.auth.can(me, 'app', 'audit')) { $('denied').hidden = false; return; }
  ['filters', 'meta', 'board'].forEach((id) => { $(id).hidden = false; });

  const CATEGORY = { security: '로그인·보안', data: '데이터 변경', admin: '관리자 작업' };
  const cat = IAS.combo($('catBox'), { items: [{ value: '', label: '전체' }, ...Object.entries(CATEGORY).map(([value, label]) => ({ value, label }))], emptyText: '목록에 없습니다' });
  cat.set('');
  const rowsEl = $('rows'), board = $('board');
  const sorter = IAS.sortable(board);
  IAS.stickyShadow(rowsEl);

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date(), weekAgo = new Date(Date.now() - 6 * 86400000);
  $('from').value = iso(weekAgo); $('to').value = iso(today);

  function params(extra = {}) {
    const p = new URLSearchParams();
    if ($('from').value) p.set('from', Math.floor(new Date($('from').value + 'T00:00:00').getTime() / 1000));
    if ($('to').value) p.set('to', Math.floor(new Date($('to').value + 'T23:59:59').getTime() / 1000));
    if (cat.value) p.set('category', cat.value);
    if ($('q').value.trim()) p.set('q', $('q').value.trim());
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }

  const fmt = (sec) => { const d = new Date(sec * 1000); return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const full = (sec) => new Date(sec * 1000).toLocaleString('ko-KR');
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };

  let items = [], hasMore = false, busy = false;

  function draw() {
    rowsEl.textContent = '';
    items.forEach((r) => {
      const row = el('div', 'hboard-row' + (r.ok ? '' : ' unread')); row.setAttribute('role', 'row');
      row.title = [full(r.at), `${CATEGORY[r.category] || r.category} · ${r.event}`, r.summary, r.actor ? `사용자: ${r.actorName || ''} (${r.actor})` : '', r.ip ? `IP: ${r.ip}` : '', r.ua ? `기기: ${r.ua}` : '',
        r.targetType ? `대상: ${r.targetType}:${r.targetId}` : '', r.req ? `요청: ${r.req}` : ''].filter(Boolean).join('\n');
      const dot = el('span', 'dot'); dot.dataset.v = r.ok ? '0' : '1';
      const ti = el('span', 'ti'); ti.appendChild(el('b', null, `${CATEGORY[r.category] || r.category} · ${r.summary || r.event}`));
      const wr = el('span', 'wr', r.actorName || r.actor || '-');
      const dt = el('span', 'dt', fmt(r.at)); dt.dataset.v = String(r.at);
      row.append(dot, ti, wr, dt); rowsEl.appendChild(row);
    });
    if (!items.length) rowsEl.appendChild(el('div', 'state', '조건에 맞는 기록이 없습니다'));
    if (hasMore) { const b = el('button', 'btn btn-glass more', '더 보기'); b.type = 'button'; b.addEventListener('click', () => load(false)); rowsEl.appendChild(b); }
    $('count').textContent = `${items.length}건 표시${hasMore ? ' (더 있음)' : ''}`;
    sorter.refresh();
  }

  async function load(reset) {
    if (busy) return; busy = true;
    try {
      const extra = { limit: 100 }; if (!reset && items.length) extra.before = items[items.length - 1].id;
      const r = await fetch('/api/admin/audit?' + params(extra), { credentials: 'same-origin' });
      if (r.status === 401) return location.replace('login.html?next=' + encodeURIComponent(location.pathname));
      if (r.status === 403) { $('denied').hidden = false; ['filters', 'meta', 'board'].forEach((id) => { $(id).hidden = true; }); return; }
      if (!r.ok) throw new Error('load');
      const data = await r.json();
      items = reset ? data.items : items.concat(data.items); hasMore = data.hasMore; draw();
    } catch (_) {
      rowsEl.textContent = ''; rowsEl.appendChild(el('div', 'state', '불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    } finally { busy = false; }
  }

  $('go').addEventListener('click', () => load(true));
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(true); });
  $('csv').addEventListener('click', () => { location.href = '/api/admin/audit.csv?' + params(); });
  load(true);
})();
