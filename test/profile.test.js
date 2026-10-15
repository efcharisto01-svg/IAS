import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openDb, DEMO_PASSWORD } from '../server/db.js';
import { registerApp } from '../server/apps.js';

let app, base;
before(async () => {
  registerApp({ id: 'board', name: '게시판' });
  app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

async function login(userId, company = 'acme', ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537') {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify({ company, userId, password: DEMO_PASSWORD }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const api = (path, { method = 'GET', cookie, json, body, type } = {}) => fetch(base + path, {
  method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(type ? { 'Content-Type': type } : {}) },
  body: json !== undefined ? JSON.stringify(json) : body,
});
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

test('/me has the profile fields, settings and the apps the user may use', async () => {
  const c = await login('kim');
  const me = await (await api('/api/auth/me', { cookie: c })).json();
  assert.equal(me.user.name, '김하늘'); assert.equal(me.user.department, '총무팀'); assert.equal(me.user.jobTitle, '대리');
  assert.equal(me.user.email, 'kim@acme.example'); assert.equal(me.user.hasPhoto, false);
  assert.deepEqual(me.settings, { theme: 'system', notifyOff: [] });
  assert.deepEqual(me.apps, [], 'kim has no grant for board yet');
  const admin = await (await api('/api/auth/me', { cookie: await login('admin') })).json();
  assert.deepEqual(admin.apps, [{ id: 'board', name: '게시판' }], 'admin has * grant');
});

test('email and phone can be changed (and cleared); bad values are rejected; name/department are not editable', async () => {
  const c = await login('kim');
  let r = await api('/api/me/profile', { method: 'PUT', cookie: c, json: { email: ' new.kim@acme.example ', phone: '010-9999-8888' } });
  assert.equal(r.status, 200);
  let p = await r.json(); assert.equal(p.email, 'new.kim@acme.example'); assert.equal(p.phone, '010-9999-8888');
  for (const bad of [{ email: 'nope', phone: '' }, { email: 'a@b', phone: '' }, { email: '', phone: 'abc' }, { email: '', phone: '1' }, { email: 5, phone: '' }])
    assert.equal((await api('/api/me/profile', { method: 'PUT', cookie: c, json: bad })).status, 400, JSON.stringify(bad));
  r = await api('/api/me/profile', { method: 'PUT', cookie: c, json: { email: '', phone: '', name: 'Hacker', department: 'X', jobTitle: 'CEO' } });
  p = await r.json(); assert.equal(p.email, ''); assert.equal(p.phone, '');
  assert.equal(p.name, '김하늘'); assert.equal(p.department, '총무팀'); assert.equal(p.jobTitle, '대리');
  assert.equal((await api('/api/me/profile', { method: 'PUT', json: { email: '', phone: '' } })).status, 401);
});

test('photo: upload, serve with ETag, shrink limits, only real images, delete', async () => {
  const c = await login('kim');
  assert.equal((await api('/api/me/photo', { cookie: c })).status, 404);
  assert.equal((await api('/api/me/photo', { method: 'POST', cookie: c, type: 'image/jpeg', body: JPEG })).status, 200);
  const me = await (await api('/api/auth/me', { cookie: c })).json(); assert.equal(me.user.hasPhoto, true); assert.ok(me.user.photoVersion > 0);
  const g = await api('/api/me/photo', { cookie: c });
  assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/jpeg');
  assert.match(g.headers.get('content-security-policy'), /sandbox/); assert.equal(Buffer.from(await g.arrayBuffer()).equals(JPEG), true);
  const etag = g.headers.get('etag');
  assert.equal((await fetch(base + '/api/me/photo', { headers: { Cookie: c, 'If-None-Match': etag } })).status, 304);
  // rejects
  assert.equal((await api('/api/me/photo', { method: 'POST', cookie: c, type: 'image/jpeg', body: Buffer.from('<html><script>alert(1)</script></html>') })).status, 400, 'html disguised as jpeg');
  assert.equal((await api('/api/me/photo', { method: 'POST', cookie: c, type: 'image/png', body: JPEG })).status, 400, 'type mismatch');
  assert.equal((await api('/api/me/photo', { method: 'POST', cookie: c, type: 'text/html', body: JPEG })).status, 415);
  assert.equal((await api('/api/me/photo', { method: 'POST', cookie: c, type: 'image/jpeg', body: Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]) })).status, 413);
  assert.equal((await api('/api/me/photo', { method: 'POST', type: 'image/jpeg', body: JPEG })).status, 401);
  assert.equal((await fetch(base + '/api/me/photo', { method: 'POST', headers: { Cookie: c, 'Content-Type': 'image/jpeg', Origin: 'https://evil.example' }, body: JPEG })).status, 403);
  assert.equal((await api('/api/me/photo/delete', { method: 'POST', cookie: c, json: {} })).status, 200);
  assert.equal((await api('/api/me/photo', { cookie: c })).status, 404);
});

test("co-workers' photos are visible inside the same company only", async () => {
  const kim = await login('kim'); const admin = await login('admin'); const other = await login('kim', 'daehan');
  await api('/api/me/photo', { method: 'POST', cookie: kim, type: 'image/jpeg', body: JPEG });
  const id = (await (await api('/api/auth/me', { cookie: kim })).json()).user.id;
  assert.equal((await api(`/api/users/${id}/photo`, { cookie: admin })).status, 200);
  assert.equal((await api(`/api/users/${id}/photo`, { cookie: other })).status, 404, 'another company');
  assert.equal((await api(`/api/users/${id}/photo`)).status, 401);
});

test('settings: theme and per-app notification switch', async () => {
  const c = await login('admin');
  assert.equal((await api('/api/me/settings', { method: 'PUT', cookie: c, json: { theme: 'neon' } })).status, 400);
  assert.equal((await api('/api/me/settings', { method: 'PUT', cookie: c, json: { notifyOff: ['../x'] } })).status, 400);
  const s = await (await api('/api/me/settings', { method: 'PUT', cookie: c, json: { theme: 'dark', notifyOff: ['board', 'board'] } })).json();
  assert.deepEqual(s, { theme: 'dark', notifyOff: ['board'] });
  assert.deepEqual((await (await api('/api/auth/me', { cookie: c })).json()).settings, s);
  const u = app.db.prepare("SELECT id, tenant_id FROM users WHERE login_id='admin' AND tenant_id=(SELECT id FROM tenants WHERE code='acme')").get();
  assert.equal(app.notify({ tenantId: u.tenant_id, userId: u.id, app: 'board', source: '게시판', title: '꺼 둔 앱' }), null, 'muted app: nothing is created');
  assert.ok(app.notify({ tenantId: u.tenant_id, userId: u.id, source: '시스템', title: '시스템은 끌 수 없음' }) > 0);
  await api('/api/me/settings', { method: 'PUT', cookie: c, json: { notifyOff: [] } });
  assert.ok(app.notify({ tenantId: u.tenant_id, userId: u.id, app: 'board', source: '게시판', title: '다시 켬' }) > 0);
});

test('sessions: list devices, log out one, log out all others, never the current one', async () => {
  const win = await login('newbie', 'daehan', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537');
  const ios = await login('newbie', 'daehan', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17 Safari/604');
  const edge = await login('newbie', 'daehan', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120');
  let list = await (await api('/api/me/sessions', { cookie: win })).json();
  assert.equal(list.length, 3); assert.equal(list.filter((s) => s.current).length, 1);
  assert.deepEqual(list.map((s) => s.device).sort(), ['Chrome · Windows', 'Edge · Windows', 'Safari · iOS']);
  const me = list.find((s) => s.current), iosS = list.find((s) => s.device === 'Safari · iOS');
  assert.equal((await (await api(`/api/me/sessions/${me.id}/logout`, { method: 'POST', cookie: win, json: {} })).json()).removed, 0, 'current session is kept');
  assert.equal((await (await api(`/api/me/sessions/${iosS.id}/logout`, { method: 'POST', cookie: win, json: {} })).json()).removed, 1);
  assert.equal((await api('/api/auth/me', { cookie: ios })).status, 401, 'that device is signed out');
  assert.equal((await (await api('/api/me/sessions/logout-others', { method: 'POST', cookie: win, json: {} })).json()).removed, 1);
  assert.equal((await api('/api/auth/me', { cookie: edge })).status, 401);
  assert.equal((await api('/api/auth/me', { cookie: win })).status, 200);
  // someone else's session id cannot be removed
  const other = await login('kim', 'acme'); const otherId = (await (await api('/api/me/sessions', { cookie: other })).json())[0].id;
  assert.equal((await (await api(`/api/me/sessions/${otherId}/logout`, { method: 'POST', cookie: win, json: {} })).json()).removed, 0);
});

test('existing databases get the new columns (migration)', () => {
  const db = openDb(':memory:');
  db.exec('DROP TABLE user_photos'); // table exists, and re-opening an old file must not fail
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const c of ['phone', 'department', 'job_title']) assert.ok(cols.includes(c), c);
});
