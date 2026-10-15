/*
 * 로그기록 (회사 관리자 전용): 칼럼명 / 한글명 / 변경전 / 변경후 / 작업일시 / 변경자
 * GET /api/admin/changes, /api/admin/changes.csv. The server decides who may read it ('audit' permission)
 * and returns only this company's rows. Empty 변경전 = there was no data before, empty 변경후 = it was deleted.
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const me = await IAS.auth.require();
  IAS.topbar.mount({ title: '로그기록', me });
  if (!IAS.auth.can(me, 'app', 'audit')) { $('denied').hidden = false; return; }
  ['filters', 'meta', 'board'].forEach((id) => { $(id).hidden = false; });

  const rowsEl = $('rows'), sorter = IAS.sortable($('board'));
  IAS.stickyShadow(rowsEl);

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('from').value = iso(new Date(Date.now() - 6 * 86400000)); $('to').value = iso(new Date());

  function params(extra = {}) {
    const p = new URLSearchParams();
    if ($('from').value) p.set('from', Math.floor(new Date($('from').value + 'T00:00:00').getTime() / 1000));
    if ($('to').value) p.set('to', Math.floor(new Date($('to').value + 'T23:59:59').getTime() / 1000));
    if ($('q').value.trim()) p.set('q', $('q').value.trim());
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };

  let items = [], hasMore = false, busy = false;

  function draw() {
    rowsEl.textContent = '';
    items.forEach((r) => {
      const row = el('div', 'hboard-row'); row.setAttribute('role', 'row');
      row.title = `${r.tableLabel} #${r.rowId}\n${r.column}\n${r.time}`;
      const col = el('span', 'ti', r.column), label = el('span', 'ti', r.label), before = el('span', 'wr', r.before), after = el('span', 'wr', r.after);
      const when = el('span', 'dt', r.time.replace(' ', '\n')); when.dataset.v = String(r.at);
      const who = el('span', 'wr', r.actorName);
      row.append(col, label, before, after, when, who); rowsEl.appendChild(row);
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
      const r = await fetch('/api/admin/changes?' + params(extra), { credentials: 'same-origin' });
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
  $('csv').addEventListener('click', () => { location.href = '/api/admin/changes.csv?' + params(); });
  load(true);
})();
