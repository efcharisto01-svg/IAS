import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { DEMO_PASSWORD, now } from '../server/db.js';
import { purgeOld } from '../server/notifications.js';

let app, base, kim, admin;
before(async () => {
  app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const uid = (l) => app.db.prepare("SELECT id, tenant_id FROM users WHERE login_id = ? AND tenant_id = (SELECT id FROM tenants WHERE code='acme')").get(l);
  kim = uid('kim'); admin = uid('admin');
});
after(() => app.close());

const call = (path, { method = 'GET', cookie, body } = {}) => fetch(base + path, {
  method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
});
async function login(userId) {
  const r = await call('/api/auth/login', { method: 'POST', body: { company: 'acme', userId, password: DEMO_PASSWORD } });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test('needs a session', async () => {
  assert.equal((await call('/api/notifications')).status, 401);
  assert.equal((await call('/api/notifications/read-all', { method: 'POST' })).status, 401);
});

test('list returns total, unread and items (newest first)', async () => {
  const c = await login('kim');
  const r = await (await call('/api/notifications', { cookie: c })).json();
  assert.equal(r.total, 2); assert.equal(r.unread, 2);
  assert.ok(r.items[0].createdAt >= r.items[1].createdAt);
  assert.equal(r.items[0].read, false);
});

test('mark one read, then all read; unread filter follows', async () => {
  const c = await login('kim');
  app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: '시스템', title: '하나 더', link: 'home.html' });
  let r = await (await call('/api/notifications', { cookie: c })).json();
  assert.equal(r.unread, 3);
  const id = r.items[0].id;
  assert.equal((await (await call(`/api/notifications/${id}/read`, { method: 'POST', cookie: c })).json()).updated, 1);
  assert.equal((await (await call(`/api/notifications/${id}/read`, { method: 'POST', cookie: c })).json()).updated, 0, 'already read');
  r = await (await call('/api/notifications?filter=unread', { cookie: c })).json();
  assert.equal(r.items.length, 2); assert.equal(r.total, 3); assert.equal(r.unread, 2);
  assert.equal((await (await call('/api/notifications/read-all', { method: 'POST', cookie: c })).json()).updated, 2);
  r = await (await call('/api/notifications', { cookie: c })).json();
  assert.equal(r.unread, 0); assert.equal(r.total, 3);
});

test("cannot read someone else's notification", async () => {
  const adminC = await login('admin');
  const kimC = await login('kim');
  const id = app.notify({ tenantId: admin.tenant_id, userId: admin.id, source: '시스템', title: '관리자 전용' });
  assert.equal((await (await call(`/api/notifications/${id}/read`, { method: 'POST', cookie: kimC })).json()).updated, 0);
  const a = await (await call('/api/notifications?filter=unread', { cookie: adminC })).json();
  assert.ok(a.items.some((n) => n.id === id), 'still unread for the owner');
});

test('notifications from an app the user cannot use are hidden and not counted', async () => {
  const c = await login('kim');
  const before = await (await call('/api/notifications', { cookie: c })).json();
  const id = app.notify({ tenantId: kim.tenant_id, userId: kim.id, app: 'board', source: '게시판', title: '새 공지', link: 'post.html?id=1' });
  let r = await (await call('/api/notifications', { cookie: c })).json();
  assert.equal(r.total, before.total); assert.ok(!r.items.some((n) => n.id === id));
  assert.equal((await (await call('/api/notifications/read-all', { method: 'POST', cookie: c })).json()).updated, 0, 'hidden ones are not touched');
  app.db.prepare("INSERT INTO user_grants (user_id, kind, resource, allow) VALUES (?, 'app', 'board', 1)").run(kim.id);
  r = await (await call('/api/notifications', { cookie: c })).json();
  assert.equal(r.total, before.total + 1); assert.equal(r.unread, 1);
  app.db.prepare("UPDATE user_grants SET allow = 0 WHERE user_id = ? AND resource = 'board'").run(kim.id);
  r = await (await call('/api/notifications', { cookie: c })).json();
  assert.equal(r.total, before.total, 'user-level block hides it again');
});

test('notifications older than 60 days are deleted and never listed', async () => {
  const c = await login('kim');
  const old = app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: '시스템', title: '오래된 알림', at: now() - 61 * 86400 });
  const fresh = app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: '시스템', title: '59일 전', at: now() - 59 * 86400 });
  const r = await (await call('/api/notifications?limit=100', { cookie: c })).json();
  assert.ok(!r.items.some((n) => n.id === old), 'hidden even before purge');
  assert.ok(r.items.some((n) => n.id === fresh));
  assert.equal(purgeOld(app.db), 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM notifications WHERE id = ?').get(old).n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM notifications WHERE id = ?').get(fresh).n, 1);
});

test('notify() rejects unsafe links', () => {
  for (const link of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '../x.html', 'a/b.html'])
    assert.throws(() => app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: 'x', title: 'x', link }), /link/, link);
  assert.doesNotThrow(() => app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: 'x', title: 'x', link: 'post.html?id=3&x=1' }));
});
