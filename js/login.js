(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('loginForm'), err = $('error'), btn = $('submit');
  const fields = ['company', 'userId', 'password'].map($);

  // restore remembered tenant/user (never the password)
  try {
    const saved = JSON.parse(localStorage.getItem('ias.login') || 'null');
    if (saved) { $('company').value = saved.company || ''; $('userId').value = saved.userId || ''; $('remember').checked = true; }
  } catch (_) {}

  $('togglePw').addEventListener('click', () => {
    const pw = $('password'), show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    $('togglePw').setAttribute('aria-label', show ? '비밀번호 숨기기' : '비밀번호 표시');
  });

  fields.forEach((f) => f.addEventListener('input', () => { f.parentElement.classList.remove('invalid'); err.textContent = ''; }));

  function fail(msg, el) {
    err.textContent = msg;
    if (el) { el.parentElement.classList.add('invalid'); el.focus(); }
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
  }

  // TODO: replace with real API (POST /api/auth/login, tenant resolved by company code)
  const authenticate = (p) => new Promise((res, rej) =>
    setTimeout(() => (p.password.length >= 4 ? res({ token: 'demo' }) : rej(new Error('아이디 또는 비밀번호가 올바르지 않습니다.'))), 900));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = { company: $('company').value.trim(), userId: $('userId').value.trim(), password: $('password').value };
    if (!p.company) return fail('회사 코드를 입력해 주세요.', $('company'));
    if (!p.userId) return fail('아이디를 입력해 주세요.', $('userId'));
    if (!p.password) return fail('비밀번호를 입력해 주세요.', $('password'));

    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      await authenticate(p);
      try {
        if ($('remember').checked) localStorage.setItem('ias.login', JSON.stringify({ company: p.company, userId: p.userId }));
        else localStorage.removeItem('ias.login');
      } catch (_) {}
      btn.innerHTML = '<span>환영합니다</span>';
      // location.href = 'home.html';  // next screen
    } catch (ex) {
      btn.disabled = false; btn.innerHTML = '<span>로그인</span>';
      fail(ex.message, $('password'));
    }
  });

  $('forgot').addEventListener('click', () => fail('회사 관리자에게 비밀번호 초기화를 요청해 주세요.'));
  $('sso').addEventListener('click', () => fail('SSO 연동은 준비 중입니다.'));
})();
