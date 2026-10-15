/*
 * 글쓰기·수정 (write.html?board=ID 또는 ?id=글번호). 쓸 수 있는 게시판은 서버가 알려 준다 (board.write.<id>).
 * 사진: 브라우저에서 1600px JPEG로 줄여 올리고 본문에 [[img:번호]] 로 넣는다. 파일: 서버가 형식·크기를 다시 확인한다.
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const me = await IAS.auth.require();
  const params = new URLSearchParams(location.search);
  const editId = Number(params.get('id')) || 0;
  IAS.topbar.mount({ title: editId ? '글 수정' : '글쓰기', me });
  const deny = (t) => { $('form').hidden = true; $('denied').textContent = t; $('denied').hidden = false; };
  if (!IAS.auth.can(me, 'app', 'board')) return deny('게시판을 쓸 수 있는 권한이 없습니다.');

  let toastT; const toast = (t) => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('on'), 2400); };
  const json = async (path, init) => {
    const r = await fetch(path, { credentials: 'same-origin', ...init });
    if (r.status === 401) { location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search)); throw new Error('auth'); }
    return r;
  };
  const MESSAGES = { INVALID_TITLE: '제목을 입력해 주세요 (120자까지).', INVALID_BODY: '내용을 입력해 주세요.', INVALID_CATEGORY: '분류를 다시 골라 주세요.', FORBIDDEN: '이 게시판에 글을 쓸 권한이 없습니다.',
    TOO_MANY_FILES: '파일은 5개까지 올릴 수 있습니다.', TOO_MANY_IMAGES: '사진은 10장까지 넣을 수 있습니다.', TOO_BIG_TOTAL: '첨부 용량이 너무 큽니다 (합계 30MB).', FILE_TYPE_NOT_ALLOWED: '올릴 수 없는 파일 형식입니다.',
    INVALID_IMAGE: '사진을 올리지 못했습니다.', TOO_LARGE: '파일이 너무 큽니다.', EMPTY_FILE: '빈 파일입니다.' };
  const msg = async (r) => { try { const d = await r.json(); return MESSAGES[d.code] || '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'; } catch (_) { return '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'; } };

  const boards = (await (await json('/api/board/boards')).json()).boards;
  let post = null, files = []; // files: { id, kind, name, size }
  if (editId) {
    const r = await json('/api/board/posts/' + editId);
    if (!r.ok) return deny(r.status === 404 ? '삭제되었거나 없는 글입니다.' : '이 글을 고칠 수 없습니다.');
    const d = await r.json();
    if (!d.flags.canEdit) return deny('이 글을 고칠 수 있는 권한이 없습니다.');
    post = d.post; files = d.files.slice();
  }
  const usable = editId ? boards.filter((b) => b.id === post.boardId) : boards.filter((b) => b.canWrite);
  if (!usable.length) return deny('글을 쓸 수 있는 게시판이 없습니다.');

  const boardCombo = IAS.combo($('boardBox'), { items: usable.map((b) => ({ value: String(b.id), label: b.name })), onChange: () => onBoard() });
  const catCombo = IAS.combo($('catBox'), { items: [], emptyText: '분류가 없습니다.' });
  const cur = () => usable.find((b) => String(b.id) === boardCombo.value) || null;
  function onBoard() {
    const b = cur(); catCombo.clear();
    catCombo.setItems([{ value: '', label: '분류 없음' }].concat(b ? b.categories.map((c) => ({ value: String(c.id), label: c.name })) : []));
    $('cat').disabled = !b || !b.categories.length; $('cat').placeholder = b && !b.categories.length ? '분류 없음' : '분류 (선택)';
    $('opts').hidden = !(b && b.canPin);
    if (!b || !b.canPin) { setSwitch($('pin'), false); setSwitch($('req'), false); }
  }
  const setSwitch = (b, on) => b.setAttribute('aria-checked', String(on));
  const isOn = (b) => b.getAttribute('aria-checked') === 'true';
  [$('pin'), $('req')].forEach((b) => b.addEventListener('click', () => setSwitch(b, !isOn(b))));

  const want = editId ? String(post.boardId) : (params.get('board') && usable.some((b) => String(b.id) === params.get('board')) ? params.get('board') : String(usable[0].id));
  boardCombo.set(want); onBoard();
  if (editId) {
    $('board').disabled = true; $('title').value = post.title; $('body').value = post.body;
    if (post.categoryId) catCombo.set(String(post.categoryId));
    setSwitch($('pin'), post.pinned); setSwitch($('req'), post.required); $('save').firstElementChild.textContent = '저장'; $('cancel').href = 'post.html?id=' + editId;
  } else $('cancel').href = 'board.html?board=' + want;
  $('form').hidden = false;

  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');
  function drawFiles() {
    const host = $('attached'); host.textContent = '';
    files.forEach((f) => {
      const row = el('div', 'attach');
      row.append(el('span', 'nm', (f.kind === 'image' ? '사진 · ' : '') + f.name), el('span', 'sz', size(f.size)));
      const rm = el('button', 'rm', '×'); rm.type = 'button'; rm.setAttribute('aria-label', f.name + ' 빼기');
      rm.addEventListener('click', () => { files = files.filter((x) => x.id !== f.id); $('body').value = $('body').value.split(`[[img:${f.id}]]`).join(''); drawFiles(); });
      row.appendChild(rm); host.appendChild(row);
    });
  }
  drawFiles();

  async function upload(kind, name, blob) {
    const r = await json('/api/board/upload?kind=' + kind, { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' }, body: blob });
    if (!r.ok) throw new Error(await msg(r));
    return r.json();
  }
  async function shrink(file) { // any phone photo -> JPEG, longest side 1600px (decoded without blob: URLs, which the page policy forbids)
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { throw new Error('사진을 읽지 못했습니다.'); }
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('사진을 읽지 못했습니다.'))), 'image/jpeg', 0.85));
  }
  const count = (k) => files.filter((f) => f.kind === k).length;
  async function busy(fn) { $('save').disabled = $('addImg').disabled = $('addFile').disabled = true; try { await fn(); } catch (e) { if (e.message !== 'auth') toast(e.message); } finally { $('save').disabled = $('addImg').disabled = $('addFile').disabled = false; } }

  $('addImg').addEventListener('click', () => $('imgIn').click());
  $('addFile').addEventListener('click', () => $('fileIn').click());
  $('imgIn').addEventListener('change', () => busy(async () => {
    const list = Array.from($('imgIn').files); $('imgIn').value = '';
    for (const file of list) {
      if (count('image') >= 10) throw new Error('사진은 10장까지 넣을 수 있습니다.');
      const f = await upload('image', file.name.replace(/\.\w+$/, '') + '.jpg', await shrink(file));
      files.push(f); const ta = $('body'), at = ta.selectionStart ?? ta.value.length, tok = `\n[[img:${f.id}]]\n`;
      ta.value = ta.value.slice(0, at) + tok + ta.value.slice(ta.selectionEnd ?? at); ta.selectionStart = ta.selectionEnd = at + tok.length;
    }
    drawFiles();
  }));
  $('fileIn').addEventListener('change', () => busy(async () => {
    const list = Array.from($('fileIn').files); $('fileIn').value = '';
    for (const file of list) {
      if (count('file') >= 5) throw new Error('파일은 5개까지 올릴 수 있습니다.');
      if (file.size > 10 * 1048576) throw new Error(`${file.name}: 10MB를 넘습니다.`);
      files.push(await upload('file', file.name, file)); drawFiles();
    }
  }));

  $('form').addEventListener('submit', (e) => {
    e.preventDefault(); $('err').textContent = '';
    const title = $('title').value.trim(), body = $('body').value;
    $('titleBox').classList.toggle('invalid', !title); $('body').classList.toggle('invalid', !body.trim());
    if (!cur()) { $('err').textContent = '게시판을 골라 주세요.'; boardCombo.focus(); return; }
    if (!title) { $('title').focus(); return; }
    if (!body.trim()) { $('body').focus(); return; }
    busy(async () => {
      const used = files.filter((f) => f.kind === 'file' || body.includes(`[[img:${f.id}]]`));
      const payload = { boardId: cur().id, categoryId: catCombo.value ? Number(catCombo.value) : null, title, body, fileIds: used.map((f) => f.id) };
      if (cur().canPin) { payload.pinned = isOn($('pin')); payload.required = isOn($('req')); }
      const r = await json(editId ? '/api/board/posts/' + editId : '/api/board/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) { $('err').textContent = await msg(r); return; }
      location.replace('post.html?id=' + (await r.json()).id);
    });
  });
})();
