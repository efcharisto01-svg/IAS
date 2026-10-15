/* 임시 홈 확인 화면용. 홈 화면 확정 후 삭제한다. */
(async () => {
  const $ = (id) => document.getElementById(id);
  const me = await IAS.auth.require();
  IAS.topbar.mount({ title: '홈', me });
  const list = (el, items) => { el.textContent = ''; (items.length ? items : ['없음']).forEach((t) => { const s = document.createElement('span'); s.className = 'pill'; s.textContent = t; el.appendChild(s); }); };
  $('hello').textContent = `${me.user.name}님, 환영합니다`;
  $('co').textContent = `${me.user.tenant.name} · ${me.user.loginId}`;
  list($('roles'), me.roles.map((r) => r.name));
  const show = (p) => p.allow.includes('*') ? ['전체'] : p.allow.filter((x) => !p.deny.includes(x));
  list($('apps'), show(me.permissions.app));
  list($('widgets'), show(me.permissions.widget));
  $('logout').addEventListener('click', () => IAS.auth.logout());
})();
