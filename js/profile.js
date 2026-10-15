/*
 * IAS profile panel + personal settings (css: .profile-panel, .menu-*, .switch, .segmented ...).
 * Opened from the avatar button of the top bar (js/topbar.js calls IAS.profile.attach).
 *   - 내 정보: email and phone can be changed. Name, department, job title are managed by the company admin.
 *   - Profile photo (shrunk to 512px JPEG in the browser, stored on the server)
 *   - 알림 설정: device notifications on/off for this device, per-app notification on/off
 *   - 화면 설정: theme (system / light / dark), saved on the account
 *   - 비밀번호 변경, 로그인한 기기 (log out one / all others), 로그아웃
 */
(function (global) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    bell: '<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>',
    key: '<rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  };
  const CHEV = svg('<path d="M9 5l7 7-7 7"/>').replace('<svg ', '<svg class="menu-chev" ');
  const BACK = svg('<path d="M15 5l-7 7 7 7"/>');
  const THEME_LABEL = { system: '시스템 설정', light: '라이트', dark: '다크' };
  const PUSH_NOTE = {
    denied: '브라우저 설정에서 이 사이트의 알림을 허용해 주세요.',
    insecure: '보안 연결(HTTPS)에서만 기기 알림을 쓸 수 있습니다.',
    'ios-install': '아이폰은 홈 화면에 추가한 뒤 기기 알림을 받을 수 있습니다.',
    unsupported: '이 브라우저는 기기 알림을 지원하지 않습니다.',
  };

  const json = (method, path, body) => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body ?? {}) });
  const ago = (sec) => { const m = Math.max(0, Math.floor((Date.now() / 1000 - sec) / 60)); return m < 1 ? '방금' : m < 60 ? m + '분 전' : m < 1440 ? Math.floor(m / 60) + '시간 전' : Math.floor(m / 1440) + '일 전'; };

  /** Fill a round avatar node with the photo (or the first letter of the name). */
  function paintAvatar(node, user) {
    node.querySelectorAll('img').forEach((i) => i.remove());
    const hasText = [...node.childNodes].some((n) => n.nodeType === 3);
    if (!hasText) node.insertBefore(document.createTextNode(user.name.charAt(0)), node.firstChild);
    if (user.hasPhoto) {
      const img = el('img'); img.alt = ''; img.src = `/api/me/photo?v=${user.photoVersion}`;
      img.addEventListener('error', () => img.remove());
      node.appendChild(img);
    }
  }

  /** Photo -> square 512px JPEG (removes metadata, keeps uploads small). */
  async function shrink(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch (_) {
      bmp = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file); });
    }
    const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight, s = Math.min(w, h), size = Math.min(512, s);
    const c = document.createElement('canvas'); c.width = c.height = size;
    c.getContext('2d').drawImage(bmp, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
    return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('toBlob'))), 'image/jpeg', 0.85));
  }

  function attach({ me, button, scrim, onUserChange }) {
    let U = { ...me.user }, settings = { ...me.settings }, apps = me.apps || [];
    const roles = me.roles || [];
    const panel = el('section', 'notif-panel profile-panel'); panel.id = 'profilePanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '프로필');
    const views = el('div', 'pviews'); panel.appendChild(views); document.body.appendChild(panel);
    const toastEl = el('div', 'toast'); toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl);
    const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.hidden = true; document.body.appendChild(fileInput);
    let stack = ['main'], tt = null;

    function toast(text) { toastEl.textContent = text; toastEl.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('on'), 2400); }
    function changed() { paintAvatar(button, U); if (onUserChange) onUserChange(U); }

    // ---------- small builders ----------
    function menuRow(ic, bg, title, value, go) {
      const b = el('button', 'menu-row'); b.type = 'button';
      const i = el('span', 'menu-ic'); i.style.background = bg; i.innerHTML = svg(ICON[ic]); b.appendChild(i);
      b.appendChild(el('span', 'menu-t', title)); if (value) b.appendChild(el('span', 'menu-v', value));
      b.insertAdjacentHTML('beforeend', CHEV); b.addEventListener('click', go); return b;
    }
    function switchRow(label, icon, on, change, disabled) {
      const r = el('div', 'menu-row static');
      const i = el('span', 'menu-ic', icon.text || ''); i.style.background = icon.bg; if (icon.svg) i.innerHTML = svg(ICON[icon.svg]); r.appendChild(i);
      r.appendChild(el('span', 'menu-t', label));
      const sw = el('button', 'switch'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(on)); sw.setAttribute('aria-label', label); sw.disabled = !!disabled;
      sw.addEventListener('click', async () => { sw.disabled = true; try { await change(sw.getAttribute('aria-checked') !== 'true', sw); } finally { sw.disabled = !!disabled; } });
      r.appendChild(sw); return r;
    }
    function view(name, title, fill) {
      const v = el('div', 'pview'); v.dataset.v = name;
      if (title) {
        const h = el('div', 'phead'); const b = el('button', 'pback'); b.type = 'button'; b.innerHTML = BACK + '<span>뒤로</span>';
        b.addEventListener('click', () => nav(stack[stack.length - 2], true)); h.appendChild(b); h.appendChild(el('h2', null, title)); v.appendChild(h);
      }
      const s = el('div', 'pscroll'); fill(s); v.appendChild(s); return v;
    }

    // ---------- views ----------
    function buildMain() {
      return view('main', null, (s) => {
        const card = el('div', 'me-card');
        const photo = el('div', 'me-photo'); paintAvatar(photo, U);
        const cam = el('button', 'cam'); cam.type = 'button'; cam.setAttribute('aria-label', '프로필 사진 바꾸기'); cam.innerHTML = svg(ICON.cam);
        cam.addEventListener('click', () => fileInput.click()); photo.appendChild(cam); card.appendChild(photo);
        card.appendChild(el('b', null, U.name));
        card.appendChild(el('span', 'sub', [U.tenant.name, U.department, U.jobTitle].filter(Boolean).join(' · ')));
        card.appendChild(el('span', 'sub', U.loginId));
        const chips = el('div', 'me-chips'); roles.forEach((r) => chips.appendChild(el('span', 'me-chip', r.name))); card.appendChild(chips);
        if (U.hasPhoto) { const d = el('button', 'me-link', '사진 삭제'); d.type = 'button'; d.addEventListener('click', removePhoto); card.appendChild(d); }
        s.appendChild(card);
        const g = el('div', 'menu-group');
        g.appendChild(menuRow('user', '#0a84ff', '내 정보', U.email || '미입력', () => nav('edit')));
        const n = menuRow('bell', '#ff9f0a', '알림 설정', '', () => nav('notify')); g.appendChild(n);
        g.appendChild(menuRow('moon', '#5e5ce6', '화면 설정', THEME_LABEL[settings.theme], () => nav('display')));
        s.appendChild(g);
        const g2 = el('div', 'menu-group');
        g2.appendChild(menuRow('key', '#34c759', '비밀번호 변경', '', () => { location.href = 'change-password.html'; }));
        g2.appendChild(menuRow('phone', '#30b0c7', '로그인한 기기', '', () => nav('devices')));
        s.appendChild(g2);
        const out = el('button', 'danger-btn', '로그아웃'); out.type = 'button'; out.addEventListener('click', () => global.IAS.auth.logout()); s.appendChild(out);
        if (global.IAS.push) global.IAS.push.state().then((st) => { const v = n.querySelector('.menu-v'); if (v) { v.textContent = st === 'on' ? '기기 알림 켜짐' : st === 'off' ? '기기 알림 꺼짐' : ''; } });
      });
    }

    function buildEdit() {
      return view('edit', '내 정보', (s) => {
        const field = (label, value, readonly, type) => {
          const d = el('div', 'pf-field'); const l = el('label', null, label);
          if (readonly) { l.insertAdjacentHTML('beforeend', svg(ICON.lock)); l.appendChild(el('span', null, '관리자가 관리')); }
          const i = el('input'); i.value = value; i.readOnly = !!readonly; i.setAttribute('aria-label', label); if (type) i.type = type; if (!readonly) { i.autocomplete = type === 'email' ? 'email' : 'tel'; }
          d.append(l, i); s.appendChild(d); return { d, i };
        };
        field('이름', U.name, true); field('회사', U.tenant.name, true); field('부서 · 직책', [U.department, U.jobTitle].filter(Boolean).join(' · ') || '-', true);
        const email = field('이메일', U.email, false, 'email'), phone = field('전화번호', U.phone, false, 'tel');
        const err = el('div', 'pf-err'); err.setAttribute('role', 'alert'); s.appendChild(err);
        [email, phone].forEach((f) => f.i.addEventListener('input', () => { f.d.classList.remove('invalid'); err.textContent = ''; }));
        const save = el('button', 'pf-save', '저장'); save.type = 'button';
        save.addEventListener('click', async () => {
          save.disabled = true;
          try {
            const r = await json('PUT', '/api/me/profile', { email: email.i.value, phone: phone.i.value });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
              const bad = data.code === 'INVALID_PHONE' ? phone : email;
              bad.d.classList.add('invalid'); bad.i.focus();
              err.textContent = data.code === 'INVALID_EMAIL' ? '이메일 형식이 올바르지 않습니다.' : data.code === 'INVALID_PHONE' ? '전화번호는 숫자, +, -, 공백, 괄호로 5~20자 입력해 주세요.' : '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.';
              return;
            }
            U = { ...U, ...data }; changed(); toast('저장했습니다'); rebuild('main'); nav('main', true);
          } catch (_) { err.textContent = '네트워크에 연결할 수 없습니다.'; }
          finally { save.disabled = false; }
        });
        s.appendChild(save);
      });
    }

    function buildNotify() {
      return view('notify', '알림 설정', (s) => {
        const g = el('div', 'menu-group'); const holder = el('div'); g.appendChild(holder); s.appendChild(g);
        const note = el('p', 'pnote'); s.appendChild(note);
        const drawPush = async () => {
          const st = global.IAS.push ? await global.IAS.push.state() : 'unsupported';
          holder.textContent = '';
          const usable = st === 'on' || st === 'off';
          holder.appendChild(switchRow('이 기기로 알림 받기', { bg: '#ff9f0a', svg: 'phone' }, st === 'on', async (want) => {
            try { await (want ? global.IAS.push.enable() : global.IAS.push.disable()); } catch (_) { toast('기기 알림을 바꾸지 못했습니다'); }
            await drawPush();
          }, !usable));
          note.textContent = usable ? '알림이 화면에 떠 있는 시간은 브라우저와 기기 설정을 따릅니다.' : PUSH_NOTE[st] || '';
        };
        drawPush();
        s.appendChild(el('p', 'pnote', '앱별로 알림을 받을지 정합니다.'));
        if (!apps.length) { s.appendChild(el('p', 'pnote', '아직 알림을 받을 앱이 없습니다. 앱이 추가되면 여기에 나타납니다.')); return; }
        const g2 = el('div', 'menu-group');
        apps.forEach((a) => g2.appendChild(switchRow(a.name, { bg: '#0a84ff', text: a.name.charAt(0) }, !settings.notifyOff.includes(a.id), async (want, sw) => {
          const next = want ? settings.notifyOff.filter((x) => x !== a.id) : [...settings.notifyOff, a.id];
          const r = await json('PUT', '/api/me/settings', { notifyOff: next });
          if (!r.ok) { toast('저장하지 못했습니다'); return; }
          settings = await r.json(); sw.setAttribute('aria-checked', String(want));
        })));
        s.appendChild(g2);
        s.appendChild(el('p', 'pnote', '시스템 알림(비밀번호, 새 기기 로그인 등)은 끌 수 없습니다.'));
      });
    }

    function buildDisplay() {
      return view('display', '화면 설정', (s) => {
        s.appendChild(el('p', 'pnote', '테마'));
        const seg = el('div', 'segmented');
        [['system', '시스템'], ['light', '라이트'], ['dark', '다크']].forEach(([mode, label]) => {
          const b = el('button', 'segmented-opt', label); b.type = 'button'; b.setAttribute('aria-pressed', String(settings.theme === mode));
          b.addEventListener('click', async () => {
            if (settings.theme === mode) return;
            global.IAS.theme.apply(mode); settings.theme = mode;
            [...seg.children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
            const r = await json('PUT', '/api/me/settings', { theme: mode });
            if (!r.ok) toast('저장하지 못했습니다. 이 기기에서만 바뀝니다');
          });
          seg.appendChild(b);
        });
        s.appendChild(seg);
        s.appendChild(el('p', 'pnote', '시스템은 기기의 라이트·다크 설정을 따라갑니다. 선택은 계정에 저장되어 다른 기기에서도 같게 보입니다.'));
      });
    }

    function buildDevices() {
      return view('devices', '로그인한 기기', (s) => {
        const holder = el('div'); s.appendChild(holder);
        const draw = async () => {
          let list = [];
          try { const r = await fetch('/api/me/sessions', { credentials: 'same-origin' }); if (r.ok) list = await r.json(); } catch (_) { /* shown empty */ }
          holder.textContent = '';
          const g = el('div', 'menu-group');
          list.forEach((d) => {
            const r = el('div', 'dev-row'); r.appendChild(el('b', null, d.device)); r.appendChild(el('span', d.current ? 'here' : null, d.current ? '지금 이 기기' : '로그인 ' + ago(d.createdAt)));
            if (!d.current) { const b = el('button', null, '로그아웃'); b.type = 'button'; b.addEventListener('click', async () => { await json('POST', `/api/me/sessions/${d.id}/logout`); toast('그 기기에서 로그아웃했습니다'); draw(); }); r.appendChild(b); }
            g.appendChild(r);
          });
          holder.appendChild(g);
          if (list.length > 1) { const b = el('button', 'danger-btn', '다른 모든 기기에서 로그아웃'); b.type = 'button'; b.addEventListener('click', async () => { await json('POST', '/api/me/sessions/logout-others'); toast('다른 기기에서 모두 로그아웃했습니다'); draw(); }); holder.appendChild(b); }
          holder.appendChild(el('p', 'pnote', '모르는 기기가 보이면 바로 로그아웃하고 비밀번호를 바꿔 주세요.'));
        };
        draw();
      });
    }

    const BUILD = { main: buildMain, edit: buildEdit, notify: buildNotify, display: buildDisplay, devices: buildDevices };
    function rebuild(name) { const old = views.querySelector(`[data-v="${name}"]`); const v = BUILD[name](); if (old) old.replaceWith(v); else views.appendChild(v); }
    function show(name, back) { views.querySelectorAll('.pview').forEach((v) => { v.classList.remove('on', 'back'); if (v.dataset.v === name) { v.classList.add('on'); if (back) v.classList.add('back'); } }); }
    function nav(name, back) {
      if (back) { const i = stack.lastIndexOf(name); stack = i >= 0 ? stack.slice(0, i + 1) : ['main']; } else stack.push(name);
      rebuild(name); // fresh data each time (devices list, push state)
      show(name, back);
    }

    async function removePhoto() {
      const r = await json('POST', '/api/me/photo/delete'); if (!r.ok) return toast('사진을 지우지 못했습니다');
      U = { ...U, ...(await r.json()) }; changed(); rebuild('main'); show('main', false); toast('사진을 지웠습니다');
    }
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0]; fileInput.value = ''; if (!f) return;
      try {
        const blob = await shrink(f);
        const r = await fetch('/api/me/photo', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, credentials: 'same-origin', body: blob });
        if (!r.ok) throw new Error('upload');
        U = { ...U, ...(await r.json()) }; changed(); rebuild('main'); show('main', false); toast('프로필 사진을 바꿨습니다');
      } catch (_) { toast('사진을 올리지 못했습니다. 다른 사진으로 시도해 주세요'); }
    });

    // ---------- open / close ----------
    function setOpen(on) {
      panel.classList.toggle('on', on); if (scrim) scrim.classList.toggle('on', on); button.setAttribute('aria-expanded', String(on));
      if (on) { stack = ['main']; rebuild('main'); show('main', false); }
    }
    const isOpen = () => panel.classList.contains('on');
    button.addEventListener('click', () => setOpen(!isOpen()));
    const onKey = (e) => {
      if (e.key !== 'Escape' || !isOpen()) return;
      if (stack.length > 1) nav(stack[stack.length - 2], true); else { setOpen(false); button.focus(); }
    };
    const onDown = (e) => { if (isOpen() && !panel.contains(e.target) && !button.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onDown, true);

    changed(); rebuild('main');
    return { close: () => setOpen(false), destroy() { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); panel.remove(); toastEl.remove(); fileInput.remove(); } };
  }

  global.IAS = global.IAS || {};
  global.IAS.profile = { attach, paintAvatar };
})(window);
