/*
 * IAS shared component: searchable dropdown (combobox)
 * Styles: css/glass.css (.combo, .combo-list, .combo-opt, .combo-empty, .combo-hint)
 *
 * Markup contract:
 *   <div class="field combo" id="box">
 *     <svg class="ico">…</svg>
 *     <input id="x" type="text" role="combobox" aria-expanded="false" aria-controls="xList" autocomplete="off">
 *     <button type="button" class="trailing" tabindex="-1"><svg class="caret">…</svg></button>
 *     <ul class="combo-list" id="xList" role="listbox" hidden></ul>
 *   </div>
 *
 * Usage:
 *   const co = IAS.combo(box, {
 *     items: [{ value: 'acme', label: '에이씨엠이', sub: 'acme' }],
 *     recent: () => ['acme'],          // optional: values shown first when the box is empty
 *     onChange: (item | null) => {},   // optional
 *     onPick: () => {},                // optional: after a mouse/Enter pick (e.g. move focus on)
 *   });
 *   co.value  -> selected value or ''      co.set(value)   co.clear()
 *   co.settle() -> exact label/value match counts as a choice (call before submit)
 *   co.focus()   co.setItems(items)   co.el
 */
(function (global) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mark = (text, q) => {
    const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    return i < 0 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  };

  function combo(box, opts) {
    opts = opts || {};
    const input = box.querySelector('input[role="combobox"]');
    const list = box.querySelector('.combo-list');
    const toggle = box.querySelector('.trailing');
    const emptyText = opts.emptyText || '검색 결과가 없습니다.';
    const recentLabel = opts.recentLabel || '최근 사용';
    let items = opts.items || [], shown = [], active = -1, current = null;

    const recent = () => (opts.recent ? opts.recent() : []) || [];
    const byValue = (v) => items.find((i) => i.value === v);

    function filter(q) {
      q = q.trim().toLowerCase();
      if (!q) {
        const r = recent().map(byValue).filter(Boolean);
        return r.concat(items.filter((i) => !r.includes(i)));
      }
      return items.filter((i) => i.label.toLowerCase().includes(q) || String(i.sub || i.value).toLowerCase().includes(q));
    }
    function draw() {
      const q = current && input.value === current.label ? '' : input.value.trim();
      shown = filter(q); active = shown.length ? 0 : -1;
      if (!shown.length) { list.innerHTML = '<li class="combo-empty" role="presentation">' + esc(emptyText) + '</li>'; return; }
      const hint = !q && recent().length ? '<li class="combo-hint" role="presentation">' + esc(recentLabel) + '</li>' : '';
      list.innerHTML = hint + shown.map((c, i) =>
        '<li class="combo-opt' + (current && c.value === current.value ? ' chosen' : '') + '" role="option" id="' + input.id + '-opt-' + i + '" data-i="' + i + '" aria-selected="' + (i === active) + '">' +
        '<span class="nm">' + mark(c.label, q) + '</span><span class="cd">' + (c.sub != null ? mark(String(c.sub), q) : '') + '</span></li>').join('');
    }
    function setActive(i) {
      if (!shown.length) return;
      active = (i + shown.length) % shown.length;
      list.querySelectorAll('.combo-opt').forEach((o) => o.setAttribute('aria-selected', String(+o.dataset.i === active)));
      const el = document.getElementById(input.id + '-opt-' + active);
      input.setAttribute('aria-activedescendant', input.id + '-opt-' + active);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function open() {
      draw(); list.hidden = false; box.classList.add('open'); input.setAttribute('aria-expanded', 'true');
      const r = box.getBoundingClientRect();
      box.classList.toggle('up', window.innerHeight - r.bottom < 280 && r.top > 280);
      setActive(0);
    }
    function close() { list.hidden = true; box.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    function commit(item) {
      const changed = (current && current.value) !== (item && item.value);
      current = item || null;
      if (item) input.value = item.label;
      if (opts.hidden) opts.hidden.value = item ? item.value : '';
      box.classList.remove('invalid');
      if (changed && opts.onChange) opts.onChange(current);
    }
    function pick(item) { commit(item); close(); if (opts.onPick) opts.onPick(item); }
    function settle() {
      const t = input.value.trim().toLowerCase();
      if (!t) return commit(null);
      const m = items.find((i) => String(i.value).toLowerCase() === t || i.label.toLowerCase() === t);
      commit(m || null);
    }

    input.addEventListener('input', () => { commit(null); open(); });
    input.addEventListener('focus', () => { if (list.hidden) open(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); list.hidden ? open() : setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list.hidden ? open() : setActive(active - 1); }
      else if (e.key === 'Enter' && !list.hidden && active >= 0) { e.preventDefault(); pick(shown[active]); }
      else if (e.key === 'Escape') close();
      else if (e.key === 'Tab') { if (!list.hidden && active >= 0 && input.value.trim()) commit(shown[active]); close(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement)) { settle(); close(); } }, 120));
    list.addEventListener('pointerdown', (e) => e.preventDefault()); // keep input focus
    list.addEventListener('click', (e) => { const o = e.target.closest('.combo-opt'); if (o) pick(shown[+o.dataset.i]); });
    if (toggle) {
      toggle.addEventListener('pointerdown', (e) => e.preventDefault());
      toggle.addEventListener('click', () => { if (list.hidden) { input.focus(); open(); } else close(); });
    }
    document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target)) close(); });

    return {
      el: box, input,
      get value() { return current ? current.value : ''; },
      get text() { return input.value.trim(); },
      set(v) { const i = byValue(v); commit(i || null); if (!i) input.value = ''; },
      clear() { input.value = ''; commit(null); },
      settle, close, focus(opts2) { input.focus(opts2); },
      setItems(next) { items = next || []; },
    };
  }

  global.IAS = global.IAS || {};
  global.IAS.combo = combo;
})(window);
