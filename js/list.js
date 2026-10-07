/*
 * IAS list helpers
 *
 * IAS.stickyShadow(bodyEl)
 *   adds .scrolled to the parent .hboard (헤더게시판) once the .hboard-body is scrolled,
 *   so the fixed header gets a shadow.
 *
 * IAS.sortable(hboardEl, { col, dir })
 *   헤더게시판 rule: every header cell is a .sort button, so every column sorts.
 *   Header cell i sorts by row cell i. Sort value = cell.dataset.v, else its text.
 *   Numbers sort numerically, everything else with Korean collation.
 *   Rows with .pin (공지) always stay on top.
 *   Click cycle per column: first direction -> opposite direction -> back to the original order.
 *   First direction is asc, or desc when the header button has data-first="desc".
 *   Optional { col, dir } sets the initial sort (the authored order is still the "original").
 *   Returns { sort(col, dir), reset() }.
 */
(function (global) {
  function stickyShadow(el) {
    const host = el.closest('.hboard') || el;
    const on = () => host.classList.toggle('scrolled', el.scrollTop > 2);
    el.addEventListener('scroll', on, { passive: true }); on();
  }

  function sortable(host, opts) {
    opts = opts || {};
    const head = host.querySelector('.hboard-head'), body = host.querySelector('.hboard-body');
    const cols = Array.from(head.children);
    const original = Array.from(body.querySelectorAll('.hboard-row')); // authored order = 원상복귀 target
    const val = (row, i) => { const c = row.children[i]; return c && c.dataset.v !== undefined ? c.dataset.v : (c ? c.textContent.trim() : ''); };

    function sort(i, dir) {
      const rows = Array.from(body.querySelectorAll('.hboard-row'));
      const pinned = rows.filter((r) => r.classList.contains('pin'));
      const rest = rows.filter((r) => !r.classList.contains('pin'));
      const numeric = rest.length && rest.every((r) => val(r, i) !== '' && !isNaN(val(r, i)));
      const f = dir === 'asc' ? 1 : -1;
      rest.sort((a, b) => f * (numeric ? val(a, i) - val(b, i) : String(val(a, i)).localeCompare(String(val(b, i)), 'ko')));
      pinned.concat(rest).forEach((r) => body.appendChild(r));
      cols.forEach((c, k) => { if (k === i) c.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending'); else c.removeAttribute('aria-sort'); });
      body.scrollTop = 0;
    }

    function reset() {
      original.forEach((r) => body.appendChild(r));
      cols.forEach((c) => c.removeAttribute('aria-sort'));
      body.scrollTop = 0;
    }

    cols.forEach((c, i) => c.addEventListener('click', () => {
      const first = c.dataset.first === 'desc' ? 'desc' : 'asc', second = first === 'asc' ? 'desc' : 'asc';
      const cur = c.getAttribute('aria-sort');
      const curDir = cur === 'ascending' ? 'asc' : cur === 'descending' ? 'desc' : null;
      if (!curDir) sort(i, first);
      else if (curDir === first) sort(i, second);
      else reset();
    }));
    if (opts.col != null) sort(opts.col, opts.dir || 'asc');
    return { sort, reset };
  }

  global.IAS = global.IAS || {};
  global.IAS.stickyShadow = stickyShadow;
  global.IAS.sortable = sortable;
})(window);
