/*
 * 게시판 관리 (board-manage.html, 권한 board.manage): 게시판 만들기·고치기·숨기기, 분류, 역할별 읽기/쓰기/고정 권한.
 * 권한은 역할 단위로 board.read.<id>, board.write.<id>, board.pin.<id> 에 저장된다 (서버 /api/board/manage/*).
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const me = await IAS.auth.require();
  IAS.topbar.mount({ title: '게시판 관리', me, actions: [{ id: 'back', label: '게시판', onClick: () => { location.href = 'board.html'; } }] });
  if (!IAS.auth.can(me, 'app', 'board.manage')) { $('denied').hidden = false; return; }

  let toastT; const toast = (t) => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('on'), 2400); };
  const call = async (path, method, body) => {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.replace('login.html?next=' + encodeURIComponent(location.pathname)); throw new Error('auth'); }
    return r;
  };
  const MESSAGES = { INVALID_NAME: '게시판 이름을 입력해 주세요 (30자까지).', INVALID_CATEGORY: '분류 이름을 입력해 주세요 (20자까지).', TOO_MANY_CATEGORIES: '분류는 30개까지 만들 수 있습니다.', INVALID_ROLES: '역할 선택이 올바르지 않습니다.', FORBIDDEN: '권한이 없습니다.' };

  let roles = [], boards = [], editing = null; // editing: { id|null, cats: [{id?, name, orig?}], removed: [ids], read:Set, write:Set, pin:Set }
  async function load() {
    const r = await call('/api/board/manage', 'GET');
    if (r.status === 403) { $('denied').hidden = false; $('listView').hidden = $('editView').hidden = true; return false; }
    ({ roles, boards } = await r.json()); return true;
  }

  function drawList() {
    const host = $('boardRows'); host.textContent = '';
    if (!boards.length) host.appendChild(el('div', 'state', '아직 게시판이 없습니다'));
    boards.forEach((b) => {
      const row = el('button', 'menu-row' + (b.status === 'hidden' ? ' hiddenboard' : '')); row.type = 'button';
      const ic = el('span', 'menu-ic', '≡'); ic.style.background = '#0a84ff';
      const nm = el('span', 'grow', b.name);
      const sub = el('span', 'sub', (b.status === 'hidden' ? '숨김 · ' : '') + (b.categories.length ? `분류 ${b.categories.length}개` : '분류 없음'));
      row.append(ic, nm, sub); row.addEventListener('click', () => open(b)); host.appendChild(row);
    });
    $('listView').hidden = false; $('editView').hidden = true;
  }

  const adminRole = (r) => r.key === 'admin';
  function open(b) {
    editing = b ? { id: b.id, cats: b.categories.map((c) => ({ id: c.id, name: c.name, orig: c.name })), removed: [], read: new Set(b.readRoles), write: new Set(b.writeRoles), pin: new Set(b.pinRoles), hidden: b.status === 'hidden' }
      : { id: null, cats: [], removed: [], read: new Set(), write: new Set(), pin: new Set(), hidden: false };
    roles.filter(adminRole).forEach((r) => { editing.read.add(r.id); editing.write.add(r.id); editing.pin.add(r.id); });
    $('editTitle').textContent = b ? '게시판 고치기' : '새 게시판'; $('name').value = b ? b.name : ''; $('err').textContent = ''; $('nameBox').classList.remove('invalid'); $('catNew').value = '';
    $('hideWrap').hidden = !b; setHidden(editing.hidden);
    drawCats(); drawPerms();
    $('listView').hidden = true; $('editView').hidden = false; $('name').focus();
  }
  const setHidden = (on) => { editing.hidden = on; $('hide').setAttribute('aria-checked', String(on)); };
  $('hide').addEventListener('click', () => setHidden(!editing.hidden));

  function drawCats() {
    const host = $('cats'); host.textContent = '';
    editing.cats.forEach((c, i) => {
      const row = el('div', 'catrow'); const f = el('div', 'field'); f.insertAdjacentHTML('beforeend', '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>'); const inp = el('input'); inp.type = 'text'; inp.maxLength = 20; inp.value = c.name; inp.setAttribute('aria-label', '분류 이름');
      inp.addEventListener('input', () => { c.name = inp.value; }); f.appendChild(inp);
      const rm = el('button', 'rm', '×'); rm.type = 'button'; rm.setAttribute('aria-label', c.name + ' 빼기');
      rm.addEventListener('click', () => { if (c.id) editing.removed.push(c.id); editing.cats.splice(i, 1); drawCats(); });
      row.append(f, rm); host.appendChild(row);
    });
  }
  function addCat() {
    const name = $('catNew').value.trim(); if (!name) { $('catNew').focus(); return; }
    editing.cats.push({ name }); $('catNew').value = ''; drawCats(); $('catNew').focus();
  }
  $('catAdd').addEventListener('click', addCat);
  $('catNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCat(); } });

  function drawPerms() {
    const host = $('perms'); host.textContent = '';
    const head = el('div', 'perm head'); head.append(el('span', null, '역할'), el('span', null, '읽기'), el('span', null, '쓰기'), el('span', null, '고정')); host.appendChild(head);
    roles.forEach((r) => {
      const row = el('div', 'perm'); row.appendChild(el('span', null, r.name));
      for (const kind of ['read', 'write', 'pin']) {
        const sw = el('button', 'switch'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', `${r.name} ${{ read: '읽기', write: '쓰기', pin: '고정' }[kind]}`);
        const on = editing[kind].has(r.id); sw.setAttribute('aria-checked', String(on)); sw.disabled = adminRole(r);
        sw.addEventListener('click', () => {
          const s = editing[kind];
          if (s.has(r.id)) { s.delete(r.id); if (kind === 'read') { editing.write.delete(r.id); editing.pin.delete(r.id); } }
          else { s.add(r.id); if (kind !== 'read') editing.read.add(r.id); }
          drawPerms();
        });
        row.appendChild(sw);
      }
      host.appendChild(row);
    });
  }

  $('newBoard').addEventListener('click', () => open(null));
  $('cancel').addEventListener('click', drawList);

  $('editView').addEventListener('submit', async (e) => {
    e.preventDefault(); $('err').textContent = '';
    const name = $('name').value.trim();
    if (!name) { $('nameBox').classList.add('invalid'); $('name').focus(); return; }
    $('nameBox').classList.remove('invalid');
    const cats = editing.cats.map((c) => ({ ...c, name: c.name.trim() }));
    if (cats.some((c) => !c.name)) { $('err').textContent = MESSAGES.INVALID_CATEGORY; return; }
    const ids = (s) => Array.from(s);
    $('save').disabled = true;
    try {
      const fail = async (r) => { let code = ''; try { code = (await r.json()).code; } catch (_) {} $('err').textContent = MESSAGES[code] || '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'; };
      if (!editing.id) {
        const r = await call('/api/board/manage/boards', 'POST', { name, categories: cats.map((c) => c.name), readRoles: ids(editing.read), writeRoles: ids(editing.write), pinRoles: ids(editing.pin) });
        if (!r.ok) return fail(r);
      } else {
        let r = await call('/api/board/manage/boards/' + editing.id, 'POST', { name, status: editing.hidden ? 'hidden' : 'active', readRoles: ids(editing.read), writeRoles: ids(editing.write), pinRoles: ids(editing.pin) });
        if (!r.ok) return fail(r);
        for (const id of editing.removed) { r = await call('/api/board/manage/categories/' + id, 'DELETE'); if (!r.ok) return fail(r); }
        for (const c of cats) {
          if (!c.id) r = await call(`/api/board/manage/boards/${editing.id}/categories`, 'POST', { name: c.name });
          else if (c.name !== c.orig) r = await call('/api/board/manage/categories/' + c.id, 'POST', { name: c.name });
          else continue;
          if (!r.ok) return fail(r);
        }
      }
      toast('저장했습니다'); await load(); drawList();
    } catch (err) { if (err.message !== 'auth') $('err').textContent = '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'; }
    finally { $('save').disabled = false; }
  });

  if (await load()) drawList();
})();
