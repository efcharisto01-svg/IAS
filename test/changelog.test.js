import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { DEMO_PASSWORD, now, openDb } from '../server/db.js';
import { asUser, withoutLog, TRACKED, UNTRACKED, installChangeLog, changesToCsv } from '../server/changelog.js';

let app, base;
before(async () => {
  app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const api = (path, { method = 'GET', cookie, json, type, body } = {}) => fetch(base + path, {
  method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(type ? { 'Content-Type': type } : {}) }, body: json !== undefined ? JSON.stringify(json) : body,
});
async function login(userId, company = 'acme') {
  const r = await api('/api/auth/login', { method: 'POST', json: { company, userId, password: DEMO_PASSWORD } });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const urow = (l, code = 'acme') => app.db.prepare('SELECT u.* FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.login_id = ? AND t.code = ?').get(l, code);
const logs = (where = '1=1', ...a) => app.db.prepare(`SELECT * FROM change_log WHERE ${where} ORDER BY id`).all(...a);

test('seeding writes nothing to the change log', () => assert.equal(logs().length, 0));

test('an edit logs one row per changed column: before, after, time, who', async () => {
  const c = await login('kim');
  const n0 = logs().length;
  await api('/api/me/profile', { method: 'PUT', cookie: c, json: { email: 'new@acme.example', phone: '010-5555-6666' } });
  const r = logs("actor = 'kim'").slice(n0 === 0 ? 0 : 0);
  const email = r.find((x) => x.column_name === 'users.email'), phone = r.find((x) => x.column_name === 'users.phone');
  assert.equal(email.column_label, '이메일'); assert.equal(email.before, 'kim@acme.example'); assert.equal(email.after, 'new@acme.example');
  assert.equal(phone.before, null, 'no data before -> empty'); assert.equal(phone.after, '010-5555-6666');
  assert.equal(email.actor_name, '김하늘'); assert.equal(email.table_label, '사용자'); assert.equal(email.row_id, String(urow('kim').id));
  assert.ok(Math.abs(email.at - now()) < 5); assert.equal(email.tenant_id, urow('kim').tenant_id);
  assert.equal(r.filter((x) => x.column_name === 'users.name').length, 0, 'unchanged columns are not logged');
});

test('deleting data logs before=value and after=empty; clearing a value too', async () => {
  const c = await login('kim');
  await api('/api/me/profile', { method: 'PUT', cookie: c, json: { email: 'new@acme.example', phone: '' } });
  const clear = logs("column_name = 'users.phone'").pop();
  assert.equal(clear.before, '010-5555-6666'); assert.equal(clear.after, null);
  await api('/api/me/photo', { method: 'POST', cookie: c, type: 'image/jpeg', body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]), Buffer.alloc(300, 1)]) });
  const photo = logs("column_name = 'user_photos.data'").pop();
  assert.equal(photo.before, null); assert.match(photo.after, /^\[이진 데이터 \d+바이트\]$/);
  await api('/api/me/photo/delete', { method: 'POST', cookie: c, json: {} });
  const gone = logs("column_name = 'user_photos.data'").pop();
  assert.match(gone.before, /^\[이진 데이터/); assert.equal(gone.after, null);
});

test('secrets are hidden, settings and permissions are tracked, noisy columns are not', async () => {
  const c = await login('newbie');
  await api('/api/auth/change-password', { method: 'POST', cookie: c, json: { current: DEMO_PASSWORD, next: 'Brandnew123' } });
  const pw = logs("column_name = 'users.pw_hash'").pop();
  assert.equal(pw.before, '[숨김]'); assert.equal(pw.after, '[숨김]'); assert.equal(pw.column_label, '비밀번호'); assert.equal(pw.actor, 'newbie');
  assert.equal(logs("column_name = 'users.must_change_pw'").pop().after, '0');
  assert.ok(!JSON.stringify(logs()).includes('scrypt$'), 'no hash text anywhere');
  const k = await login('kim');
  await api('/api/me/settings', { method: 'PUT', cookie: k, json: { theme: 'dark' } });
  assert.equal(logs("column_name = 'user_settings.value'").pop().after, 'dark');
  const before = logs().length;
  for (let i = 0; i < 6; i++) await api('/api/auth/login', { method: 'POST', json: { company: 'acme', userId: 'newbie', password: 'wrong' + i } });
  assert.equal(logs().length, before, 'failed-login counters / lock time are not in the column log');
  // permissions
  const adm = urow('admin');
  asUser(app.db, adm, () => app.db.prepare("INSERT INTO user_grants (user_id, kind, resource, allow) VALUES (?, 'app', 'board', 0)").run(urow('kim').id));
  const g = logs("table_name = 'user_grants' AND column_name = 'user_grants.allow'").pop();
  assert.equal(g.after, '0'); assert.equal(g.actor, 'admin'); assert.equal(g.tenant_id, adm.tenant_id);
  asUser(app.db, adm, () => app.db.prepare("DELETE FROM user_grants WHERE user_id = ? AND resource = 'board'").run(urow('kim').id));
  const del = logs("table_name = 'user_grants' AND column_name = 'user_grants.resource'").pop();
  assert.equal(del.before, 'board'); assert.equal(del.after, null);
});

test('writes outside asUser are logged as the system; withoutLog writes nothing', () => {
  const kim = urow('kim');
  app.db.prepare('UPDATE users SET job_title = ? WHERE id = ?').run('과장', kim.id);
  const r = logs("column_name = 'users.job_title'").pop();
  assert.equal(r.actor, null); assert.equal(r.before, '대리'); assert.equal(r.after, '과장');
  const n = logs().length;
  withoutLog(app.db, () => app.db.prepare('UPDATE users SET job_title = ? WHERE id = ?').run('부장', kim.id));
  assert.equal(logs().length, n);
  assert.throws(() => asUser(app.db, kim, async () => {}), /synchronous/);
  assert.equal(app.db.prepare('SELECT user_id FROM audit_ctx').get().user_id, null, 'actor is cleared even when it failed');
});

test('the log is append-only and keeps rows for 3 years', () => {
  const id = logs().pop().id;
  assert.throws(() => app.db.prepare('UPDATE change_log SET after = ? WHERE id = ?').run('x', id), /append-only/);
  assert.throws(() => app.db.prepare('DELETE FROM change_log WHERE id = ?').run(id), /kept for/);
  const old = Number(app.db.prepare("INSERT INTO change_log (at, tenant_id, table_name, table_label, row_id, column_name, column_label, before, after) VALUES (?, 1, 't', 't', '1', 't.c', 'c', 'a', 'b')").run(now() - 1200 * 86400).lastInsertRowid);
  app.db.prepare('DELETE FROM change_log WHERE id = ?').run(old);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM change_log WHERE id = ?').get(old).n, 0);
});

test('every table and every column is decided and has a Korean name (nothing is left out silently)', () => {
  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  for (const t of tables) assert.ok(TRACKED.some((x) => x.table === t) || t in UNTRACKED, `${t} is neither tracked nor untracked`);
  for (const spec of TRACKED) {
    const cols = app.db.prepare(`PRAGMA table_info(${spec.table})`).all().map((c) => c.name);
    for (const c of cols) assert.ok(c in spec.columns || c in (spec.ignore || {}), `${spec.table}.${c} has no Korean name`);
    for (const [c, label] of Object.entries(spec.columns)) assert.ok(/[가-힣]/.test(label), `${spec.table}.${c}: Korean name`);
  }
  const db = openDb(':memory:'); db.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  assert.throws(() => installChangeLog(db), /decide for table\(s\) posts/, 'a new table must be decided');
  const db2 = openDb(':memory:'); db2.exec('ALTER TABLE users ADD COLUMN nickname TEXT');
  assert.throws(() => installChangeLog(db2), /no Korean name for column\(s\) nickname/, 'a new column needs a Korean name');
});

test('admin API: own company only, filters, time to the second, CSV in the agreed format', async () => {
  const kim = await login('kim'), adm = await login('admin'), other = await login('admin', 'daehan');
  assert.equal((await api('/api/admin/changes', { cookie: kim })).status, 403);
  assert.equal((await api('/api/admin/changes')).status, 401);
  const all = await (await api('/api/admin/changes?limit=200', { cookie: adm })).json();
  assert.ok(all.items.length > 5);
  const it = all.items.find((x) => x.column === 'users.email');
  assert.deepEqual(Object.keys(it).sort(), ['actor', 'actorName', 'after', 'at', 'before', 'column', 'id', 'label', 'rowId', 'table', 'tableLabel', 'time'].sort());
  assert.match(it.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(typeof it.before, 'string'); assert.equal(typeof it.after, 'string', 'empty is "" not null');
  assert.ok(all.items.every((x) => logs('id = ?', x.id)[0].tenant_id === urow('admin').tenant_id));
  const o = await (await api('/api/admin/changes?limit=200', { cookie: other })).json();
  assert.ok(!o.items.some((x) => all.items.some((y) => y.id === x.id)));
  const q = await (await api('/api/admin/changes?q=' + encodeURIComponent('이메일'), { cookie: adm })).json();
  assert.ok(q.items.length > 0 && q.items.every((x) => x.label === '이메일' || JSON.stringify(x).includes('이메일')));
  const t = await (await api('/api/admin/changes?table=user_settings', { cookie: adm })).json(); assert.ok(t.items.every((x) => x.table === 'user_settings'));
  const p1 = await (await api('/api/admin/changes?limit=2', { cookie: adm })).json(); assert.equal(p1.hasMore, true);
  const p2 = await (await api(`/api/admin/changes?limit=2&before=${p1.items[1].id}`, { cookie: adm })).json(); assert.ok(p2.items.every((x) => x.id < p1.items[1].id));
  const r = await api('/api/admin/changes.csv', { cookie: adm });
  const bytes = Buffer.from(await r.arrayBuffer()); const text = bytes.toString('utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(text, /^﻿"칼럼명","한글명","변경전","변경후","작업일시","변경자","대상"/);
  assert.equal((await api('/api/admin/changes.csv', { cookie: kim })).status, 403);
  assert.ok(app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE event = 'changes_exported'").get().n >= 1, 'the export is logged too');
  assert.ok(changesToCsv([{ column: 'a.b', label: 'x', before: '=1+1', after: '', time: 't', actorName: 'n', actor: 'a', tableLabel: 'T', rowId: '1' }]).includes(`"'=1+1"`));
});
