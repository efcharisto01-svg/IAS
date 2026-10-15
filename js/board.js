/*
 * 게시판 목록 (board.html): 게시판·분류 고르기, 검색, 헤더게시판(모든 칼럼 정렬).
 * GET /api/board/boards, /api/board/posts. 읽기·쓰기 권한은 게시판마다 서버가 정한다 (board.read.<id> 등).
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const me = await IAS.auth.require();
  if (!IAS.auth.can(me, 'app', 'board')) { IAS.topbar.mount({ title: '게시판', me }); $('denied').hidden = false; return; }

  const get = async (path) => {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (r.status === 401) { location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search)); throw new Error('auth'); }
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  };

  let data;
  try { data = await get('/api/board/boards'); } catch (_) { IAS.topbar.mount({ title: '게시판', me }); $('deniedText').textContent = '불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'; $('denied').hidden = false; return; }
  const boards = data.boards;
  const writable = boards.filter((b) => b.canWrite);

  const actions = [];
  if (data.canManage) actions.push({ id: 'manage', label: '관리', onClick: () => { location.href = 'board-manage.html'; } });
  if (writable.length) actions.push({ id: 'write', label: '글쓰기', onClick: () => { location.href = 'write.html?board=' + (current() && current().canWrite ? current().id : writable[0].id); } });
  IAS.topbar.mount({ title: '게시판', me, actions });

  if (!boards.length) {
    $('deniedText').textContent = data.canManage ? '게시판이 없습니다. 오른쪽 위 "관리"에서 만들어 주세요.' : '볼 수 있는 게시판이 없습니다.';
    $('denied').hidden = false; return;
  }
  ['filters', 'meta', 'list'].forEach((id) => { $(id).hidden = false; });

  const rowsEl = $('rows'), sorter = IAS.sortable($('list'));
  IAS.stickyShadow(rowsEl);

  const label = (b) => b.name;
  const boardCombo = IAS.combo($('boardBox'), {
    items: [{ value: '', label: '전체 게시판' }].concat(boards.map((b) => ({ value: String(b.id), label: label(b), sub: b.unread ? `안 읽음 ${b.unread}` : '' }))),
    onChange: () => { setCats(); load(true); },
  });
  const catCombo = IAS.combo($('catBox'), { items: [{ value: '', label: '전체 분류' }], emptyText: '분류가 없습니다.', onChange: () => load(true) });
  const current = () => boards.find((b) => String(b.id) === boardCombo.value) || null;
  function setCats() {
    const b = current();
    catCombo.clear();
    catCombo.setItems([{ value: '', label: '전체 분류' }].concat(b ? b.categories.map((c) => ({ value: String(c.id), label: c.name })) : []));
    $('cat').disabled = !b || !b.categories.length;
    $('cat').placeholder = b && !b.categories.length ? '분류 없음' : '전체 분류';
  }
  const want = new URLSearchParams(location.search).get('board');
  if (want && boards.some((b) => String(b.id) === want)) boardCombo.set(want);
  setCats();

  const pad = (n) => String(n).padStart(2, '0');
  function when(sec) {
    const d = new Date(sec * 1000), t = new Date();
    return d.toDateString() === t.toDateString() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  }

  let items = [], hasMore = false, busy = false;
  function draw() {
    rowsEl.textContent = '';
    items.forEach((p) => {
      const row = el('a', 'hboard-row' + (p.unread ? ' unread' : '') + (p.pinned ? ' pin' : ''));
      row.href = 'post.html?id=' + p.id; row.setAttribute('role', 'row');
      const dot = el('span', 'dot'); dot.dataset.v = p.unread ? '1' : '0';
      const ti = el('span', 'ti'); ti.dataset.v = p.title;
      if (p.required) ti.appendChild(el('span', 'tag req', '필독'));
      else if (p.pinned) ti.appendChild(el('span', 'tag pin', '공지'));
      if (!current()) ti.appendChild(el('span', 'tag sub', p.boardName));
      if (p.categoryName) ti.appendChild(el('span', 'tag sub', p.categoryName));
      ti.appendChild(el('b', null, p.title));
      if (p.hasFiles) { ti.appendChild(el('span', 'tag sub', '첨부')); }
      if (p.comments) ti.appendChild(el('span', 'tag cnt', `[${p.comments}]`));
      const wr = el('span', 'wr', p.author);
      const dt = el('span', 'dt', when(p.createdAt)); dt.dataset.v = String(p.createdAt);
      row.append(dot, ti, wr, dt); rowsEl.appendChild(row);
    });
    if (!items.length) rowsEl.appendChild(el('div', 'state', '게시글이 없습니다'));
    if (hasMore) { const b = el('button', 'btn btn-glass more', '더 보기'); b.type = 'button'; b.addEventListener('click', () => load(false)); rowsEl.appendChild(b); }
    $('count').textContent = `${items.length}건 표시${hasMore ? ' (더 있음)' : ''}`;
    const un = items.filter((p) => p.unread).length;
    $('unread').textContent = un ? `안 읽음 ${un}건` : '';
    sorter.refresh();
  }

  async function load(reset) {
    if (busy) return; busy = true;
    try {
      const p = new URLSearchParams({ limit: '50' });
      if (boardCombo.value) p.set('board', boardCombo.value);
      if (catCombo.value) p.set('category', catCombo.value);
      if ($('q').value.trim()) p.set('q', $('q').value.trim());
      const normal = items.filter((x) => !x.pinned);
      if (!reset && normal.length) p.set('before', normal[normal.length - 1].id);
      const d = await get('/api/board/posts?' + p);
      items = reset ? d.items : items.concat(d.items); hasMore = d.hasMore; draw();
    } catch (e) {
      if (e.message === 'auth') return;
      rowsEl.textContent = ''; rowsEl.appendChild(el('div', 'state', '불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    } finally { busy = false; }
  }

  $('go').addEventListener('click', () => load(true));
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
  load(true);
})();
