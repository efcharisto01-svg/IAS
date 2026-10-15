import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { DEMO_PASSWORD } from '../server/db.js';
import { registerApp, registerWidget, catalogFor } from '../server/apps.js';
import { cleanLayout } from '../server/layout.js';
import { effectivePermissions } from '../server/db.js';

let app, base;
before(async () => {
  app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const api = (path, { method = 'GET', cookie, json } = {}) => fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
async function login(userId, company = 'acme') {
  const r = await api('/api/auth/login', { method: 'POST', json: { company, userId, password: DEMO_PASSWORD } });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const uid = (l, code = 'acme') => app.db.prepare('SELECT u.id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.login_id = ? AND t.code = ?').get(l, code).id;

test('registry: 로그기록 app and its widget exist; ids and links are validated', () => {
  const admin = catalogFor(effectivePermissions(app.db, uid('admin')));
  assert.deepEqual(admin.apps.map((a) => a.id), ['audit']); assert.equal(admin.apps[0].name, '로그기록'); assert.equal(admin.apps[0].link, 'log.html');
  assert.deepEqual(admin.widgets.map((w) => w.id), ['audit.recent']); assert.equal(admin.widgets[0].script, 'js/widgets/audit-recent.js');
  const kim = catalogFor(effectivePermissions(app.db, uid('kim')));
  assert.deepEqual(kim, { apps: [], widgets: [] }, 'no grants: nothing on the home screen');
  assert.throws(() => registerApp({ id: 'bad id', name: 'x' }), /id and name/);
  assert.throws(() => registerApp({ id: 'x', name: 'x', link: 'https://evil.example' }), /same-site/);
  assert.throws(() => registerWidget({ id: 'x', name: 'x', size: 'huge', script: 'js/x.js' }), /size/);
  assert.throws(() => registerWidget({ id: 'x', name: 'x', size: 'small', script: 'https://evil/x.js' }), /script/);
});

test('/me carries the catalog; the default layout shows everything the user may use', async () => {
  const c = await login('admin');
  const me = await (await api('/api/auth/me', { cookie: c })).json();
  assert.deepEqual(me.catalog.apps.map((a) => a.id), ['audit']);
  const r = await (await api('/api/me/layout', { cookie: c })).json();
  assert.equal(r.layout.saved, false); assert.deepEqual(r.layout.apps, ['audit']); assert.deepEqual(r.layout.widgets, ['audit.recent']);
  const k = await (await api('/api/me/layout', { cookie: await login('kim') })).json();
  assert.deepEqual(k.layout.apps, []); assert.deepEqual(k.layout.widgets, []);
  assert.equal((await api('/api/me/layout')).status, 401);
});

test('saving: validation, normalisation, and what is saved is filtered by permission every time', async () => {
  const c = await login('admin');
  for (const bad of [null, {}, { widgets: 'x', apps: [], hidden: [] }, { widgets: [], apps: ['bad id'], hidden: [] }, { widgets: [], apps: [{ folder: true, id: 'x', apps: [] }], hidden: [] }, { widgets: ['../x'], apps: [], hidden: [] }])
    assert.equal((await api('/api/me/layout', { method: 'PUT', cookie: c, json: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await api('/api/me/layout', { method: 'PUT', cookie: c, json: { widgets: [], apps: Array(201).fill('a'), hidden: [] } })).status, 400);
  // an app the user has no permission for is dropped; a folder with one usable app dissolves
  const r = await (await api('/api/me/layout', { method: 'PUT', cookie: c, json: { widgets: ['audit.recent', 'nope.widget', 'audit.recent'], apps: [{ folder: true, id: 'f1', name: '  ', apps: ['audit', 'secret'] }, 'secret2'], hidden: ['secret3'], split: { l: 5 } } })).json();
  assert.deepEqual(r.layout.widgets, ['audit.recent']); assert.deepEqual(r.layout.apps, ['audit']); assert.deepEqual(r.layout.hidden, []); assert.equal(r.layout.split.l, 0.88, 'split is clamped');
  assert.equal(r.layout.saved, true);
});

test('a block (user_grants allow=0) removes the app and widget even from a saved layout', async () => {
  const c = await login('admin'), a = uid('admin');
  await api('/api/me/layout', { method: 'PUT', cookie: c, json: { widgets: ['audit.recent'], apps: ['audit'], hidden: [], split: { l: 0.5 } } });
  app.db.prepare("INSERT INTO user_grants (user_id, kind, resource, allow) VALUES (?, 'app', 'audit', 0)").run(a);
  app.db.prepare("INSERT INTO user_grants (user_id, kind, resource, allow) VALUES (?, 'widget', 'audit.recent', 0)").run(a);
  let r = await (await api('/api/me/layout', { cookie: c })).json();
  assert.deepEqual(r.layout.apps, []); assert.deepEqual(r.layout.widgets, []); assert.deepEqual(r.catalog, { apps: [], widgets: [] });
  assert.equal((await api('/api/admin/changes', { cookie: c })).status, 403, 'and the server itself refuses the log');
  app.db.prepare("DELETE FROM user_grants WHERE user_id = ?").run(a);
  r = await (await api('/api/me/layout', { cookie: c })).json();
  assert.deepEqual(r.layout.apps, ['audit']); assert.equal(r.layout.split.l, 0.5, 'saved arrangement comes back');
});

test('new apps appear at the end, hidden apps stay hidden, new widgets are not added by themselves; reset restores the default', async () => {
  const c = await login('admin');
  registerApp({ id: 'newapp', name: '새 앱', color: '#ff0000', link: 'newapp.html' });
  registerWidget({ id: 'newapp.w', name: '새 위젯', size: 'small', script: 'js/widgets/newapp.js', app: 'newapp' });
  await api('/api/me/layout', { method: 'PUT', cookie: c, json: { widgets: ['audit.recent'], apps: ['audit'], hidden: [], split: { l: 0.6 } } });
  let r = await (await api('/api/me/layout', { cookie: c })).json();
  assert.deepEqual(r.layout.apps, ['audit', 'newapp']); assert.deepEqual(r.layout.widgets, ['audit.recent']); assert.ok(r.catalog.widgets.some((w) => w.id === 'newapp.w'), 'offered in 위젯 추가');
  await api('/api/me/layout', { method: 'PUT', cookie: c, json: { widgets: [], apps: ['audit'], hidden: ['newapp'], split: { l: 0.6 } } });
  r = await (await api('/api/me/layout', { cookie: c })).json();
  assert.deepEqual(r.layout.apps, ['audit']); assert.deepEqual(r.layout.hidden, ['newapp']);
  r = await (await api('/api/me/layout/reset', { method: 'POST', cookie: c, json: {} })).json();
  assert.equal(r.layout.saved, false); assert.deepEqual(r.layout.apps, ['audit', 'newapp']);
});

test('cleanLayout is strict about folders and numbers', () => {
  assert.equal(cleanLayout({ widgets: [], apps: [{ folder: true, id: 'bad', apps: ['a'] }], hidden: [] }), null);
  const ok = cleanLayout({ widgets: [], apps: [{ folder: true, id: 'f-1', name: 'x'.repeat(40), apps: ['a', 'a', 'b'] }], hidden: [], split: { l: 'abc' } });
  assert.equal(ok.apps[0].name.length, 12); assert.deepEqual(ok.apps[0].apps, ['a', 'b']); assert.equal(ok.split.l, 0.62);
});

test('layout changes are not in the column change log (personal screen setting)', async () => {
  const before = app.db.prepare('SELECT COUNT(*) n FROM change_log').get().n;
  await api('/api/me/layout', { method: 'PUT', cookie: await login('admin'), json: { widgets: [], apps: [], hidden: [], split: { l: 0.7 } } });
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM change_log').get().n, before);
});
