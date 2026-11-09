/*
 * IAS shared component: 토스트 · 확인창 · 대화상자
 * Styles: css/glass.css (.toast .modal-back .modal)
 *
 *   IAS.ui.toast('저장했습니다');                 // 2.4초 뒤 사라짐
 *   IAS.ui.toast('저장하지 못했습니다', 'err');
 *   if (await IAS.ui.confirm({ title: '삭제할까요?', text: '되돌릴 수 없습니다', ok: '삭제', danger: true })) { ... }
 *   const close = IAS.ui.modal(node);             // 직접 만든 내용을 대화상자로. close() 로 닫음 (바깥 클릭·Esc 도 닫음)
 * 글자는 textContent 로만 넣는다(HTML 금지).
 */
(function (global) {
  const IAS = (global.IAS = global.IAS || {});
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let toastEl, toastT;
  function toast(text, kind) {
    if (!toastEl) { toastEl = el('div', 'toast'); toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = text;
    toastEl.classList.toggle('err', kind === 'err');
    toastEl.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove('on'), 2400);
  }

  function modal(content, { onClose } = {}) {
    const back = el('div', 'modal-back');
    const box = el('div', 'modal scroll-glass');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.appendChild(content); back.appendChild(box);
    const prev = document.activeElement;
    let closed = false;
    function close() {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', onKey, true);
      back.remove(); if (prev && prev.focus) prev.focus();
      if (onClose) onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'Tab') { // 포커스가 대화상자 밖으로 나가지 않게
        const f = box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    const first = box.querySelector('[autofocus], button, input, textarea, select');
    if (first) first.focus();
    return close;
  }

  function confirm({ title = '확인', text = '', ok = '확인', cancel = '취소', danger = false } = {}) {
    return new Promise((resolve) => {
      const wrap = el('div');
      wrap.appendChild(el('h2', '', title));
      if (text) wrap.appendChild(el('p', '', text));
      const row = el('div', 'btn-row even');
      const no = el('button', 'btn btn-glass', cancel); no.type = 'button';
      const yes = el('button', 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), ok); yes.type = 'button';
      row.append(no, yes); wrap.appendChild(row);
      let answer = false;
      const close = modal(wrap, { onClose: () => resolve(answer) });
      no.onclick = () => close();
      yes.onclick = () => { answer = true; close(); };
    });
  }

  IAS.ui = { toast, confirm, modal };
})(window);
