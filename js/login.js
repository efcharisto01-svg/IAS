/*
 * IAS login  (API: server/index.js)
 *   GET  /api/tenants               -> [{ code, name }]
 *   POST /api/auth/login            { company, userId, password, remember }
 *     200 { user, mustChangePassword }   (session cookie is set by the server)
 *     401 INVALID_CREDENTIALS  404 COMPANY_NOT_FOUND  403 ACCOUNT_DISABLED
 *     423 LOCKED { retryAfter }  429 TOO_MANY_REQUESTS
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('loginForm'), err = $('error'), warn = $('warn'), btn = $('submit');
  const MAX_FAILS = 5, COOLDOWN_SEC = 30;

  const store = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del: (k) => { try { localStorage.removeItem(k); } catch (_) {} },
  };

  // ---- company combobox (shared component: js/combobox.js)
  let COMPANIES = [];
  const recent = () => store.get('ias.recentCompanies') || [];
  const company = IAS.combo($('companyBox'), {
    items: [],
    recent, recentLabel: '최근 사용한 회사',
    emptyText: '검색 결과가 없습니다. 회사 관리자에게 코드를 확인해 주세요.',
    hidden: $('companyCode'),
    onChange: () => { err.textContent = ''; },
    onPick: () => $('userId').focus(),
  });
  const box = company.el;
  const loadCompanies = fetch('/api/tenants', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((list) => { COMPANIES = list; company.setItems(list.map((c) => ({ value: c.code, label: c.name, sub: c.code }))); })
    .catch(() => { company.setItems([]); company.setEmptyText('회사 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); });

  // ---- restore remembered tenant/user (never the password)
  const saved = store.get('ias.login');
  if (saved) { $('userId').value = saved.userId || ''; $('remember').checked = true; }
  (saved && saved.userId ? $('password') : { focus: (o) => company.focus(o) }).focus({ preventScroll: true });
  loadCompanies.then(() => { if (saved) company.set(saved.company); });

  // ---- password visibility
  $('togglePw').addEventListener('click', () => {
    const pw = $('password'), show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    $('togglePw').setAttribute('aria-label', show ? '비밀번호 숨기기' : '비밀번호 표시');
  });

  // ---- caps lock hint
  $('password').addEventListener('keydown', (e) => {
    warn.textContent = e.getModifierState && e.getModifierState('CapsLock') ? 'Caps Lock이 켜져 있습니다.' : '';
  });
  $('password').addEventListener('blur', () => { warn.textContent = ''; });

  // ---- clear errors while typing
  ['userId', 'password'].forEach((id) =>
    $(id).addEventListener('input', () => { $(id).parentElement.classList.remove('invalid'); err.textContent = ''; }));

  function fail(msg, el, wrap) {
    err.textContent = msg;
    if (el) { (wrap || el.parentElement).classList.add('invalid'); el.focus(); }
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
  }

  // ---- cooldown after repeated failures (client-side courtesy; server must enforce too)
  let fails = 0, lockTimer = null;
  function lock(sec) {
    clearInterval(lockTimer);
    let left = sec;
    const tick = () => {
      if (left <= 0) { clearInterval(lockTimer); btn.disabled = false; btn.innerHTML = '<span>로그인</span>'; err.textContent = ''; fails = 0; return; }
      btn.disabled = true; btn.innerHTML = `<span>${left}초 후 다시 시도</span>`; left--;
    };
    tick(); lockTimer = setInterval(tick, 1000);
  }

  // ---- API
  async function login(p) {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ company: p.company, userId: p.userId, password: p.password, remember: $('remember').checked }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { code: data.code || 'UNKNOWN', retryAfter: data.retryAfter };
    return data;
  }

  const MESSAGES = {
    INVALID_CREDENTIALS: ['아이디 또는 비밀번호가 올바르지 않습니다.', 'password'],
    COMPANY_NOT_FOUND: ['등록되지 않은 회사 코드입니다.', 'company'],
    ACCOUNT_DISABLED: ['사용이 중지된 계정입니다. 회사 관리자에게 문의해 주세요.', null],
    TOO_MANY_REQUESTS: ['시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', null],
    UNKNOWN: ['로그인 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.', null],
  };

  // only allow same-site relative redirects (?next=/board.html)
  function nextUrl(fallback) {
    const n = new URLSearchParams(location.search).get('next');
    return n && /^\/(?!\/)/.test(n) ? n : fallback;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    company.settle();
    const p = { company: company.value, userId: $('userId').value.trim(), password: $('password').value };
    if (!p.company) return fail(company.text ? '목록에서 회사를 선택해 주세요.' : '회사를 선택해 주세요.', company.input, box);
    if (!p.userId) return fail('아이디를 입력해 주세요.', $('userId'));
    if (!p.password) return fail('비밀번호를 입력해 주세요.', $('password'));

    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const out = await login(p);
      if ($('remember').checked) store.set('ias.login', { company: p.company, userId: p.userId });
      else store.del('ias.login');
      store.set('ias.recentCompanies', [p.company].concat(recent().filter((c) => c !== p.company)).slice(0, 3));
      btn.innerHTML = '<span>환영합니다</span>';
      setTimeout(() => { location.href = out.mustChangePassword ? 'change-password.html' : nextUrl('home.html'); }, 400);
    } catch (ex) {
      if (ex.code === 'LOCKED') { fail('시도 횟수를 초과했습니다.'); return lock(ex.retryAfter || COOLDOWN_SEC); }
      const [msg, field] = MESSAGES[ex.code] || MESSAGES.UNKNOWN;
      btn.disabled = false; btn.innerHTML = '<span>로그인</span>';
      fail(msg, field && $(field === 'password' ? 'password' : 'company'), field === 'company' ? box : null);
      if (ex.code === 'INVALID_CREDENTIALS' && ++fails >= MAX_FAILS) lock(COOLDOWN_SEC);
    }
  });

  $('forgot').addEventListener('click', () => fail('회사 관리자에게 비밀번호 초기화를 요청해 주세요.'));
  $('sso').addEventListener('click', () => fail('SSO 연동은 준비 중입니다.'));
})();
