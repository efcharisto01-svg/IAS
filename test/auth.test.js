import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { effectivePermissions, can } from '../server/db.js';
import { DEMO_PASSWORD } from '../server/db.js';

let app, base;
before(async () => {
  app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const post = (path, body, cookie, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body),
});
const login = (over = {}) => post('/api/auth/login', { company: 'acme', userId: 'kim', password: DEMO_PASSWORD, ...over });
const sid = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('tenant list is searchable', async () => {
  const all = await (await fetch(base + '/api/tenants')).json();
  assert.equal(all.length, 10);
  const some = await (await fetch(base + '/api/tenants?q=' + encodeURIComponent('대한'))).json();
  assert.deepEqual(some, [{ code: 'daehan', name: '대한물산' }]);
});

test('login success sets an HttpOnly SameSite cookie and /me works', async () => {
  const res = await login();
  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  assert.doesNotMatch(sc, /Max-Age/, 'session cookie unless remember');
  const body = await res.json();
  assert.equal(body.user.name, '김하늘'); assert.equal(body.mustChangePassword, false);
  const me = await (await fetch(base + '/api/auth/me', { headers: { Cookie: sid(res) } })).json();
  assert.equal(me.user.loginId, 'kim'); assert.equal(me.roles[0].key, 'member');
});

test('remember me sets Max-Age', async () => {
  const res = await login({ remember: true });
  assert.match(res.headers.get('set-cookie'), /Max-Age=2592000/);
});

test('wrong password and unknown user give the same answer', async () => {
  const a = await login({ password: 'nope' }); const b = await login({ userId: 'ghost' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
});

test('unknown company -> 404', async () => {
  const res = await login({ company: 'zzz' });
  assert.equal(res.status, 404); assert.equal((await res.json()).code, 'COMPANY_NOT_FOUND');
});

test('me without a session -> 401, logout ends the session', async () => {
  assert.equal((await fetch(base + '/api/auth/me')).status, 401);
  const res = await login(); const c = sid(res);
  assert.equal((await post('/api/auth/logout', {}, c)).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: c } })).status, 401);
});

test('5 wrong passwords lock the account (423 + retryAfter), even with the right password', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await login({ userId: 'admin', password: 'wrong' + i })).status, 401);
  const fifth = await login({ userId: 'admin', password: 'wrong5' });
  assert.equal(fifth.status, 423); assert.ok((await fifth.json()).retryAfter > 0);
  const right = await login({ userId: 'admin' });
  assert.equal(right.status, 423);
});

test('POST needs JSON and a same-origin Origin', async () => {
  const noJson = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(noJson.status, 415);
  const evil = await login({}, undefined);
  assert.equal(evil.status, 200);
  const cross = await post('/api/auth/login', { company: 'acme', userId: 'kim', password: DEMO_PASSWORD }, null, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
});

test('first-login user must change password; other sessions are closed', async () => {
  const first = await login({ userId: 'newbie' }); const c1 = sid(first);
  assert.equal((await first.json()).mustChangePassword, true);
  const other = sid(await login({ userId: 'newbie' }));
  assert.equal((await post('/api/auth/change-password', { current: DEMO_PASSWORD, next: 'short' }, c1)).status, 400);
  assert.equal((await post('/api/auth/change-password', { current: 'bad', next: 'Newpass123' }, c1)).status, 401);
  assert.equal((await post('/api/auth/change-password', { current: DEMO_PASSWORD, next: 'Newpass123' }, c1)).status, 200);
  const me = await (await fetch(base + '/api/auth/me', { headers: { Cookie: c1 } })).json();
  assert.equal(me.mustChangePassword, false);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: other } })).status, 401, 'other device signed out');
  assert.equal((await login({ userId: 'newbie' })).status, 401, 'old password no longer works');
  assert.equal((await login({ userId: 'newbie', password: 'Newpass123' })).status, 200);
});

test('permissions: role grants, wildcard, and per-user exceptions', () => {
  const db = app.db;
  const uid = (code, login) => db.prepare('SELECT u.id FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.code=? AND u.login_id=?').get(code, login).id;
  const admin = effectivePermissions(db, uid('acme', 'admin'));
  assert.ok(can(admin, 'app', 'anything') && can(admin, 'widget', 'anything'));
  const kim = uid('acme', 'kim');
  assert.ok(!can(effectivePermissions(db, kim), 'app', 'board'));
  db.prepare("INSERT INTO role_grants (role_id, kind, resource) SELECT r.id, 'app', 'board' FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=?").run(kim);
  assert.ok(can(effectivePermissions(db, kim), 'app', 'board'));
  db.prepare("INSERT INTO user_grants (user_id, kind, resource, allow) VALUES (?, 'app', 'board', 0)").run(kim);
  assert.ok(!can(effectivePermissions(db, kim), 'app', 'board'), 'user deny wins over role');
  db.prepare("INSERT INTO user_grants (user_id, kind, resource, allow) VALUES (?, 'widget', 'notice', 1)").run(kim);
  assert.ok(can(effectivePermissions(db, kim), 'widget', 'notice'), 'user allow adds');
});

test('static files: pages ok, server code and db are not served', async () => {
  assert.equal((await fetch(base + '/login.html')).status, 200);
  assert.equal((await fetch(base + '/css/glass.css')).status, 200);
  for (const p of ['/server/index.js', '/data/ias.db', '/CLAUDE.md', '/package.json', '/../package.json', '/css/../server/db.js', '/.git/config'])
    assert.equal((await fetch(base + p)).status, 404, p);
});

test('session cookie is not readable value in DB (hash stored)', async () => {
  const res = await login(); const token = decodeURIComponent(sid(res).split('=')[1]);
  const rows = app.db.prepare('SELECT id_hash FROM sessions').all();
  assert.ok(rows.length && rows.every((r) => r.id_hash !== token));
});
