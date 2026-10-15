/* 게시판 위젯 "최근 게시글": the latest posts of the boards I may read, and how many I have not read yet. Click -> the post. */
(function () {
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const pad = (n) => String(n).padStart(2, '0');
  const when = (sec) => { const d = new Date(sec * 1000), t = new Date(); return d.toDateString() === t.toDateString() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };

  IAS.widgets.define('board.recent', {
    render(body) {
      let stopped = false, timer = null;
      async function draw() {
        try {
          const r = await fetch('/api/board/recent', { credentials: 'same-origin' });
          if (stopped) return;
          if (!r.ok) throw new Error('load');
          const { items, unread } = await r.json();
          body.textContent = '';
          body.appendChild(el('div', 'widget-note', unread ? `안 읽은 글 ${unread}건` : '안 읽은 글이 없습니다'));
          if (!items.length) { body.appendChild(el('div', 'widget-note', '게시글이 없습니다')); return; }
          items.forEach((p) => {
            const row = el('div', 'widget-row');
            row.appendChild(el('i', null, when(p.createdAt)));
            const t = el('span', null, (p.required ? '[필독] ' : p.pinned ? '[공지] ' : '') + (p.unread ? '● ' : '') + p.title);
            t.appendChild(el('s', null, ` · ${p.author}`)); row.appendChild(t); body.appendChild(row);
          });
        } catch (_) { if (!stopped) { body.textContent = ''; body.appendChild(el('div', 'widget-note', '불러오지 못했습니다')); } }
      }
      draw(); timer = setInterval(draw, 60000);
      return { stop() { stopped = true; clearInterval(timer); } };
    },
  });
})();
