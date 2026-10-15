/* 로그기록 위젯 "최근 변경": the latest column changes (칼럼 한글명, 변경전 → 변경후, 시각, 변경자). Admin only. */
(function () {
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

  IAS.widgets.define('audit.recent', {
    render(body) {
      let stopped = false, timer = null;
      async function draw() {
        try {
          const r = await fetch('/api/admin/changes?limit=6', { credentials: 'same-origin' });
          if (stopped) return;
          if (!r.ok) throw new Error('load');
          const { items } = await r.json();
          body.textContent = '';
          if (!items.length) { body.appendChild(el('div', 'widget-note', '아직 변경 기록이 없습니다')); return; }
          items.forEach((c) => {
            const row = el('div', 'widget-row');
            row.appendChild(el('i', null, c.time.slice(5, 16)));
            const t = el('span', null, `${c.label}: ${c.before ? clip(c.before, 14) : '(없음)'} → ${c.after ? clip(c.after, 14) : '(삭제)'}`);
            t.appendChild(el('s', null, ` · ${c.actorName}`)); row.appendChild(t); body.appendChild(row);
          });
        } catch (_) { if (!stopped) { body.textContent = ''; body.appendChild(el('div', 'widget-note', '불러오지 못했습니다')); } }
      }
      draw(); timer = setInterval(draw, 60000);
      return { stop() { stopped = true; clearInterval(timer); } };
    },
  });
})();
