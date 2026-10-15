/*
 * 게시글 보기 (post.html?id=N): 본문, 첨부파일, 댓글. 글을 열면 서버가 읽음 처리한다.
 * 본문은 글자만 그린다: [[img:ID]] 는 본문 사진, https 주소는 링크. HTML은 쓰지 않는다.
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const me = await IAS.auth.require();
  IAS.topbar.mount({ title: '게시글', me });
  const id = Number(new URLSearchParams(location.search).get('id'));
  const fail = (text) => { ['card', 'actions', 'cmts'].forEach((k) => { $(k).hidden = true; }); $('err').textContent = text; $('err').hidden = false; $('err').appendChild(document.createElement('br')); const a = el('a', 'btn btn-glass', '목록으로'); a.href = 'board.html'; a.style.marginTop = '12px'; a.style.display = 'inline-flex'; $('err').appendChild(a); };
  if (!id) return fail('잘못된 주소입니다.');

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (s) => { const d = new Date(s * 1000); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');
  let toastT; const toast = (t) => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('on'), 2200); };
  const send = (path, method, json) => fetch(path, { method, credentials: 'same-origin', headers: json ? { 'Content-Type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined });

  // text -> DOM: links for https addresses, photos for [[img:ID]] that really belong to this post
  function renderBody(host, text, images) {
    host.textContent = '';
    const parts = text.split(/(\[\[img:\d+\]\])/);
    for (const part of parts) {
      const m = part.match(/^\[\[img:(\d+)\]\]$/);
      if (m) {
        const f = images.get(Number(m[1]));
        if (f) { const fig = el('figure'); const img = el('img'); img.src = '/api/board/files/' + f.id; img.alt = f.name; img.loading = 'lazy'; fig.appendChild(img); host.appendChild(fig); }
        continue;
      }
      let last = 0;
      for (const u of part.matchAll(/https:\/\/[^\s<>"']+/g)) {
        host.appendChild(document.createTextNode(part.slice(last, u.index)));
        const a = el('a', null, u[0]); a.href = u[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; host.appendChild(a);
        last = u.index + u[0].length;
      }
      host.appendChild(document.createTextNode(part.slice(last)));
    }
  }

  function drawComments(list, flags) {
    const host = $('cmtList'); host.textContent = '';
    $('cmtTitle').textContent = `댓글 ${list.length}개`;
    list.forEach((c) => {
      const row = el('div', 'cmt'); const head = el('div', 'cmt-head');
      head.append(el('b', null, c.author), el('span', 'when', fmt(c.createdAt)));
      if (c.canDelete) {
        const rm = el('button', 'rm', '삭제'); rm.type = 'button';
        rm.addEventListener('click', async () => {
          if (!confirm('이 댓글을 삭제할까요?')) return;
          const r = await send('/api/board/comments/' + c.id, 'DELETE');
          if (r.ok) load(); else toast('삭제하지 못했습니다');
        });
        head.appendChild(rm);
      }
      row.append(head, el('p', null, c.body)); host.appendChild(row);
    });
  }

  async function load() {
    let r;
    try { r = await fetch('/api/board/posts/' + id, { credentials: 'same-origin' }); } catch (_) { return fail('불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    if (r.status === 401) return location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search));
    if (r.status === 403) return fail('이 글을 볼 수 있는 권한이 없습니다.');
    if (r.status === 404) return fail('삭제되었거나 없는 글입니다.');
    if (!r.ok) return fail('불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    const d = await r.json(), p = d.post;
    document.title = 'IAS ' + p.title;
    const tags = $('tags'); tags.textContent = '';
    tags.appendChild(el('span', 'tag', p.boardName));
    if (p.categoryName) tags.appendChild(el('span', 'tag', p.categoryName));
    if (p.required) tags.appendChild(el('span', 'tag req', '필독')); else if (p.pinned) tags.appendChild(el('span', 'tag pin', '공지'));
    $('title').textContent = p.title;
    const by = $('by'); by.textContent = '';
    by.append(el('span', null, p.author), el('span', null, fmt(p.createdAt) + (p.updatedAt > p.createdAt ? ' (수정됨)' : '')), el('span', null, `조회 ${p.views}`));
    const images = new Map(d.files.filter((f) => f.kind === 'image').map((f) => [f.id, f]));
    renderBody($('body'), p.body, images);
    const docs = d.files.filter((f) => f.kind === 'file');
    $('files').hidden = !docs.length; $('fileList').textContent = '';
    docs.forEach((f) => {
      const a = el('a', 'attach'); a.href = '/api/board/files/' + f.id; a.setAttribute('download', f.name);
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.4-8.4"/></svg>';
      a.append(el('span', 'nm', f.name), el('span', 'sz', size(f.size))); $('fileList').appendChild(a);
    });
    $('edit').hidden = !d.flags.canEdit; $('del').hidden = !d.flags.canDelete;
    $('edit').onclick = () => { location.href = 'write.html?id=' + p.id; };
    $('del').onclick = async () => {
      if (!confirm('이 글을 삭제할까요?')) return;
      const r2 = await send('/api/board/posts/' + p.id, 'DELETE');
      if (r2.ok) location.replace('board.html?board=' + p.boardId); else toast('삭제하지 못했습니다');
    };
    $('list').href = 'board.html?board=' + p.boardId;
    drawComments(d.comments, d.flags);
    ['card', 'actions', 'cmts'].forEach((k) => { $(k).hidden = false; });
  }

  $('cform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = $('cbody').value.trim();
    if (!body) { $('cbody').classList.add('invalid'); $('cbody').focus(); return; }
    $('cbody').classList.remove('invalid'); $('csend').disabled = true;
    try {
      const r = await send(`/api/board/posts/${id}/comments`, 'POST', { body });
      if (r.ok) { $('cbody').value = ''; await load(); } else toast('등록하지 못했습니다');
    } catch (_) { toast('등록하지 못했습니다'); } finally { $('csend').disabled = false; }
  });
  load();
})();
