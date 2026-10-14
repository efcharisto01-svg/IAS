(async () => {
  const $ = (id) => document.getElementById(id);
  const form = $('pwForm'), err = $('error'), btn = $('submit');
  const me = await IAS.auth.require();
  if (me.mustChangePassword) $('lead').textContent = `${me.user.name}님, 처음 로그인하셨습니다. 새 비밀번호를 정해 주세요.`;

  ['current', 'next', 'again'].forEach((id) => $(id).addEventListener('input', () => { $(id).parentElement.classList.remove('invalid'); err.textContent = ''; }));

  function fail(msg, el) {
    err.textContent = msg;
    if (el) { el.parentElement.classList.add('invalid'); el.focus(); }
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = $('current').value, next = $('next').value;
    if (!current) return fail('현재 비밀번호를 입력해 주세요.', $('current'));
    if (!next) return fail('새 비밀번호를 입력해 주세요.', $('next'));
    if (next !== $('again').value) return fail('새 비밀번호가 서로 다릅니다.', $('again'));

    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ current, next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        btn.disabled = false; btn.innerHTML = '<span>변경하기</span>';
        if (data.code === 'INVALID_CREDENTIALS') return fail('현재 비밀번호가 올바르지 않습니다.', $('current'));
        if (data.code === 'WEAK_PASSWORD') return fail(data.message || '더 안전한 비밀번호를 사용해 주세요.', $('next'));
        if (data.code === 'SAME_PASSWORD') return fail('현재와 다른 비밀번호를 사용해 주세요.', $('next'));
        if (data.code === 'UNAUTHENTICATED') return location.replace('login.html');
        return fail('변경 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      }
      btn.innerHTML = '<span>변경되었습니다</span>';
      setTimeout(() => { location.href = 'home.html'; }, 600);
    } catch (_) {
      btn.disabled = false; btn.innerHTML = '<span>변경하기</span>';
      fail('네트워크에 연결할 수 없습니다.');
    }
  });
})();
