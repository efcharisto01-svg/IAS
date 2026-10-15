/*
 * IAS home screen: widget grid + app icon grid (css: .home, .widgets, .apps ...). Layout is saved per user.
 *   GET /api/me/layout  -> { catalog: { apps, widgets }, layout: { widgets, apps, hidden, split } }
 *   PUT /api/me/layout  (debounced), POST /api/me/layout/reset
 * What is shown is only what the user may use (the server filters). Apps/widgets register in server/modules.js.
 * 수정(edit): drag to reorder, − to remove a widget or hide an app, drop an icon on another one for 0.5s to make a folder,
 * drag a folder's app out to dissolve it, drag the bar between the grids (landscape tablet) to resize.
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const me = await IAS.auth.require();

  const home = $('home'), widgetsEl = $('widgets'), appsEl = $('apps'), splitEl = $('split'), gw = $('gw');
  let cat = { apps: [], widgets: [] }, L = { widgets: [], apps: [], hidden: [], split: { l: 0.62 } };
  let editing = false, dragMoved = false;

  const topbar = IAS.topbar.mount({ title: '홈', me, actions: [{ id: 'edit', label: '수정', onClick: () => setEditing(!editing) }] });

  // ---------------------------------------------------------------- data
  async function loadLayout(url, method) {
    const r = await fetch(url, { method: method || 'GET', headers: method ? { 'Content-Type': 'application/json' } : {}, body: method ? '{}' : undefined, credentials: 'same-origin' });
    if (!r.ok) throw new Error('layout');
    const d = await r.json(); cat = d.catalog; L = d.layout;
  }
  let saveTimer = null;
  const body = () => JSON.stringify({ widgets: L.widgets, apps: L.apps, hidden: L.hidden, split: L.split });
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 400); }
  async function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      const r = await fetch('/api/me/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: body() });
      if (!r.ok) throw new Error('save');
    } catch (_) { toast('저장하지 못했습니다. 잠시 후 다시 시도해 주세요'); }
  }
  addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); fetch('/api/me/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: body(), keepalive: true }).catch(() => {}); } });

  const toastEl = el('div', 'toast'); toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl);
  let tt = null;
  function toast(t) { toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('on'), 2400); }

  const appOf = (id) => cat.apps.find((a) => a.id === id);
  const widgetOf = (id) => cat.widgets.find((w) => w.id === id);
  const go = (link) => { if (link && /^[\w.-]+\.html$/.test(link)) location.href = link; };

  // ---------------------------------------------------------------- render
  const handles = {};
  function iconInto(node, app) {
    if (app.icon) node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${app.icon}</svg>`; // icon markup comes from the server's own registry
    else node.textContent = app.name.charAt(0);
    node.style.background = `linear-gradient(145deg, ${app.color}cc, ${app.color})`;
  }
  function removeBtn(label, onClick) { const x = el('button', 'edit-x', '−'); x.type = 'button'; x.setAttribute('aria-label', label); x.addEventListener('click', (e) => { e.stopPropagation(); onClick(); }); return x; }

  function renderWidgets() {
    Object.values(handles).forEach((h) => h && h.stop && h.stop()); for (const k of Object.keys(handles)) delete handles[k];
    widgetsEl.textContent = '';
    L.widgets.forEach((id) => {
      const w = widgetOf(id); if (!w) return;
      const card = el('div', `widget widget-${w.size}${w.tall ? ' widget-tall' : ''}`); card.dataset.id = id; card.dataset.k = 'w'; card.tabIndex = 0;
      const app = w.app && appOf(w.app); if (app && app.link) card.setAttribute('role', 'link');
      card.appendChild(el('div', 'widget-title', w.name));
      const b = el('div', 'widget-body'); card.appendChild(b);
      card.appendChild(removeBtn(`${w.name} 위젯 삭제`, () => { L.widgets = L.widgets.filter((x) => x !== id); save(); renderWidgets(); }));
      const open = () => { if (!editing && !dragMoved && app) go(app.link); };
      card.addEventListener('click', open); card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) open(); });
      widgetsEl.appendChild(card);
      IAS.widgets.render(w, b, { me, go }).then((h) => { handles[id] = h; });
    });
    if (!L.widgets.length) widgetsEl.appendChild(el('div', 'home-empty', cat.apps.length || cat.widgets.length ? '위젯이 없습니다' : '아직 사용할 수 있는 앱이 없습니다. 회사 관리자에게 권한을 요청해 주세요.'));
    const add = el('button', 'widget-add', '＋ 위젯 추가'); add.type = 'button'; add.addEventListener('click', openSheet); widgetsEl.appendChild(add);
  }

  function folderIcon(f) { const d = el('div', 'fico'); f.apps.slice(0, 4).forEach((a) => { const app = appOf(a); const i = el('i'); i.style.background = app ? app.color : '#8e8e93'; d.appendChild(i); }); return d; }
  function renderApps() {
    appsEl.textContent = '';
    L.apps.forEach((it) => {
      const d = el('div', 'app'); d.tabIndex = 0;
      if (typeof it === 'string') {
        const app = appOf(it); if (!app) return;
        d.dataset.k = 'app'; d.dataset.id = it; d.setAttribute('role', 'link'); d.setAttribute('aria-label', app.name);
        const ic = el('span', 'app-ic'); iconInto(ic, app); d.append(ic, el('span', 'app-name', app.name));
        d.appendChild(removeBtn(`${app.name} 숨기기`, () => { L.apps = L.apps.filter((x) => x !== it); L.hidden.push(it); save(); renderApps(); }));
        const open = () => { if (!editing && !dragMoved) go(app.link); };
        d.addEventListener('click', open); d.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      } else {
        d.className = 'app folder'; d.dataset.k = 'folder'; d.dataset.id = it.id; d.setAttribute('role', 'button'); d.setAttribute('aria-label', `폴더 ${it.name}`);
        d.append(folderIcon(it), el('span', 'app-name', it.name));
        const open = () => { if (!dragMoved) openFolder(it.id); };
        d.addEventListener('click', open); d.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      }
      appsEl.appendChild(d);
    });
    if (!L.apps.length) appsEl.appendChild(el('div', 'home-empty', cat.apps.length ? '표시할 앱이 없습니다' : '사용할 수 있는 앱이 없습니다'));
    renderTray();
  }

  function renderTray() {
    const chips = $('trayChips'); chips.textContent = '';
    const hidden = L.hidden.map(appOf).filter(Boolean);
    if (!hidden.length) chips.appendChild(el('span', 'widget-note', '숨긴 앱이 없습니다'));
    hidden.forEach((app) => {
      const b = el('button', 'tchip'); b.type = 'button'; const ic = el('span', 'app-ic'); iconInto(ic, app); b.append(ic, el('span', null, app.name), el('b', null, '＋'));
      b.addEventListener('click', () => { L.hidden = L.hidden.filter((x) => x !== app.id); L.apps.push(app.id); save(); renderApps(); });
      chips.appendChild(b);
    });
  }

  // ---------------------------------------------------------------- 위젯 추가 sheet
  const sheetBg = el('div', 'sheet-bg'); const sheet = el('div', 'sheet'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', '위젯 추가');
  sheetBg.appendChild(sheet); document.body.appendChild(sheetBg);
  sheetBg.addEventListener('click', (e) => { if (e.target === sheetBg) sheetBg.classList.remove('on'); });
  const SIZE_NAME = { small: '작게', wide: '넓게', full: '전체 폭' };
  function openSheet() {
    sheet.textContent = ''; sheet.appendChild(el('h2', null, '위젯 추가'));
    const left = cat.widgets.filter((w) => !L.widgets.includes(w.id));
    if (!left.length) sheet.appendChild(el('p', 'widget-note', '추가할 위젯이 없습니다.'));
    left.forEach((w) => {
      const b = el('button', 'sheet-opt', w.name); b.type = 'button'; b.appendChild(el('span', null, SIZE_NAME[w.size]));
      b.addEventListener('click', () => { L.widgets.push(w.id); save(); renderWidgets(); sheetBg.classList.remove('on'); });
      sheet.appendChild(b);
    });
    sheetBg.classList.add('on');
  }

  // ---------------------------------------------------------------- drag & drop (pointer events: mouse and touch)
  function scroller(n) { while (n && n !== document.body) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n; n = n.parentElement; } return home; }

  function enableDrag(box, sel, opt) {
    box.addEventListener('pointerdown', (e) => {
      if (!editing || e.button > 0) return;
      const it = e.target.closest(sel); if (!it || e.target.closest('.edit-x, .widget-add')) return;
      const st = { on: false, x0: e.clientX, y0: e.clientY, ex: e.clientX, ey: e.clientY, gx: 0, gy: 0, last: 0, hv: null, ft: null, dw: null, tick: null };
      const pos = () => {
        it.style.transform = ''; const lr = it.getBoundingClientRect();
        it.style.transform = `translate(${st.ex - st.gx - lr.left}px, ${st.ey - st.gy - lr.top}px) scale(1.05)`;
      };
      const clearFolder = () => { clearTimeout(st.dw); st.dw = null; if (st.ft) { st.ft.classList.remove('drop-folder'); st.ft = null; } };
      function begin() {
        st.on = true; dragMoved = true; const r = it.getBoundingClientRect(); st.gx = st.x0 - r.left; st.gy = st.y0 - r.top; it.classList.add('dragging');
        st.tick = setInterval(() => { const p = scroller(box), r2 = p.getBoundingClientRect(); if (st.ey < r2.top + 34) p.scrollTop -= 9; else if (st.ey > r2.bottom - 34) p.scrollTop += 9; pos(); evalTarget(); }, 16);
      }
      function evalTarget() {
        const items = [...box.querySelectorAll(sel)];
        const tg = items.find((x) => { if (x === it) return false; const r = x.getBoundingClientRect(); return st.ex >= r.left && st.ex <= r.right && st.ey >= r.top && st.ey <= r.bottom; });
        if (!tg) { clearFolder(); st.hv = null; return; }
        if (!st.hv || st.hv.t !== tg) st.hv = { t: tg, since: Date.now() };
        if (opt.folder && it.dataset.k === 'app') { // holding over the middle of another icon makes a folder
          const r = tg.getBoundingClientRect();
          if (Math.abs(st.ex - (r.left + r.width / 2)) < r.width * 0.3 && Math.abs(st.ey - (r.top + r.height / 2)) < r.height * 0.3) {
            if (st.dw === null && st.ft !== tg) { st.dw = setTimeout(() => { st.ft = tg; tg.classList.add('drop-folder'); }, 450); }
            return;
          }
        }
        clearFolder();
        if (Date.now() - st.hv.since < 170 || Date.now() - st.last < 140) return;
        st.last = Date.now(); st.hv = null;
        const first = items.map((x) => x.getBoundingClientRect()), di = items.indexOf(it), ti = items.indexOf(tg);
        if (di < ti) tg.after(it); else tg.before(it);
        items.forEach((x, i) => { if (x === it) return; const l = x.getBoundingClientRect(), dx = first[i].left - l.left, dy = first[i].top - l.top; if (dx || dy) x.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' }); });
        pos();
      }
      const move = (ev) => { st.ex = ev.clientX; st.ey = ev.clientY; if (!st.on) { if (Math.hypot(st.ex - st.x0, st.ey - st.y0) < 5) return; begin(); } pos(); evalTarget(); };
      const up = () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
        clearInterval(st.tick); if (!st.on) return;
        const ft = st.ft; clearFolder(); it.classList.remove('dragging'); const cur = it.style.transform; it.style.transform = '';
        it.animate([{ transform: cur || 'none' }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
        setTimeout(() => { dragMoved = false; }, 0);
        if (ft && opt.folder) { makeFolder(it.dataset.id, ft.dataset.id, ft.dataset.k); return; }
        opt.commit();
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    });
  }
  enableDrag(widgetsEl, '.widget', { commit() { L.widgets = [...widgetsEl.querySelectorAll('.widget')].map((x) => x.dataset.id); save(); } });
  enableDrag(appsEl, '.app', { folder: true, commit() {
    const folders = {}; L.apps.forEach((i) => { if (typeof i !== 'string') folders[i.id] = i; });
    L.apps = [...appsEl.querySelectorAll('.app')].map((x) => (x.dataset.k === 'folder' ? folders[x.dataset.id] : x.dataset.id)); save();
  } });

  // ---------------------------------------------------------------- folders
  const pop = el('div', 'folder-pop'); const panel = el('div', 'folder-panel');
  const nameIn = el('input'); nameIn.maxLength = 12; nameIn.setAttribute('aria-label', '폴더 이름'); const grid = el('div', 'folder-grid');
  panel.append(nameIn, grid); pop.appendChild(panel); document.body.appendChild(pop);
  let openF = null;
  const folderAt = (id) => L.apps.find((i) => typeof i !== 'string' && i.id === id);
  function makeFolder(dragId, targetId, targetKind) {
    const folders = {}; L.apps.forEach((i) => { if (typeof i !== 'string') folders[i.id] = i; });
    const order = [...appsEl.querySelectorAll('.app')].map((x) => (x.dataset.k === 'folder' ? folders[x.dataset.id] : x.dataset.id));
    const out = [];
    order.forEach((i) => {
      if (i === dragId) return;
      if (targetKind === 'folder' && typeof i !== 'string' && i.id === targetId) { i.apps.push(dragId); out.push(i); }
      else if (targetKind === 'app' && i === targetId) out.push({ folder: true, id: 'f' + Date.now().toString(36), name: '폴더', apps: [targetId, dragId] });
      else out.push(i);
    });
    L.apps = out; save(); renderApps();
  }
  function drawFolder() {
    grid.textContent = '';
    openF.apps.forEach((id) => { const app = appOf(id); if (!app) return; const d = el('div', 'app'); d.dataset.id = id; const ic = el('span', 'app-ic'); iconInto(ic, app); d.append(ic, el('span', 'app-name', app.name)); grid.appendChild(d); });
  }
  function openFolder(id) { const f = folderAt(id); if (!f) return; openF = f; nameIn.value = f.name; nameIn.readOnly = !editing; drawFolder(); pop.classList.add('on'); }
  function closeFolder() { if (!openF) return; openF.name = nameIn.value.trim() || '폴더'; openF = null; pop.classList.remove('on'); save(); renderApps(); }
  pop.addEventListener('click', (e) => { if (e.target === pop) closeFolder(); });
  grid.addEventListener('click', (e) => { if (editing) return; const d = e.target.closest('.app'); const app = d && appOf(d.dataset.id); if (app) go(app.link); });
  grid.addEventListener('pointerdown', (e) => { // drag an app out of the folder to take it out
    if (!editing || !openF) return; const it = e.target.closest('.app'); if (!it) return;
    const x0 = e.clientX, y0 = e.clientY; let ghost = null;
    const move = (ev) => {
      if (!ghost) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return; ghost = it.cloneNode(true); ghost.classList.add('ghost'); ghost.style.width = it.offsetWidth + 'px'; document.body.appendChild(ghost); it.style.opacity = '.25'; }
      ghost.style.left = ev.clientX - it.offsetWidth / 2 + 'px'; ghost.style.top = ev.clientY - 30 + 'px';
    };
    const up = (ev) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      if (!ghost) return; ghost.remove(); it.style.opacity = '';
      const pr = panel.getBoundingClientRect(); if (ev.clientX >= pr.left && ev.clientX <= pr.right && ev.clientY >= pr.top && ev.clientY <= pr.bottom) return;
      const id = it.dataset.id, f = openF; f.apps = f.apps.filter((a) => a !== id);
      const idx = L.apps.indexOf(f);
      if (f.apps.length <= 1) L.apps.splice(idx, 1, ...f.apps, id); else L.apps.splice(idx + 1, 0, id);
      openF = null; pop.classList.remove('on'); save(); renderApps();
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });

  // ---------------------------------------------------------------- splitter (landscape tablet)
  const landscape = () => matchMedia('(min-width: 900px) and (orientation: landscape)').matches;
  function applySplit() { home.style.setProperty('--split', L.split.l); splitEl.setAttribute('aria-valuenow', Math.round(L.split.l * 100)); }
  const setRatio = (r) => { if (!landscape()) return; L.split.l = Math.max(0.2, Math.min(0.88, r)); applySplit(); };
  splitEl.addEventListener('pointerdown', (e) => { e.preventDefault(); splitEl.setPointerCapture(e.pointerId); splitEl.classList.add('drag'); });
  splitEl.addEventListener('pointermove', (e) => {
    if (!splitEl.classList.contains('drag')) return;
    const hr = home.getBoundingClientRect(), cs = getComputedStyle(home), g = gw.getBoundingClientRect(), sw = splitEl.getBoundingClientRect().width;
    setRatio((e.clientX - g.left - sw / 2) / (hr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - sw));
  });
  const endSplit = () => { if (splitEl.classList.contains('drag')) { splitEl.classList.remove('drag'); save(); } };
  splitEl.addEventListener('pointerup', endSplit); splitEl.addEventListener('pointercancel', endSplit);
  splitEl.addEventListener('dblclick', () => { L.split.l = 0.62; applySplit(); save(); });
  splitEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setRatio(L.split.l - 0.03); else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setRatio(L.split.l + 0.03); else return;
    e.preventDefault(); save();
  });

  // ---------------------------------------------------------------- edit mode
  function setEditing(on) {
    editing = on; home.classList.toggle('editing', on); topbar.setActionLabel('edit', on ? '완료' : '수정');
    if (!on) { sheetBg.classList.remove('on'); closeFolder(); if (saveTimer) flush(); }
  }
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (sheetBg.classList.contains('on')) sheetBg.classList.remove('on'); else if (openF) closeFolder(); else if (editing) setEditing(false);
  });
  $('trayReset').addEventListener('click', async () => {
    try { await loadLayout('/api/me/layout/reset', 'POST'); renderWidgets(); renderApps(); applySplit(); toast('기본 배치로 되돌렸습니다'); } catch (_) { toast('되돌리지 못했습니다'); }
  });

  // ---------------------------------------------------------------- start
  try { await loadLayout('/api/me/layout'); } catch (_) { toast('홈 화면을 불러오지 못했습니다'); }
  renderWidgets(); renderApps(); applySplit();
})();
