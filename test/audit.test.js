import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { DEMO_PASSWORD, now, openDb } from '../server/db.js';
import { record, search, sanitize, retentionDays, purgeExpired, toCsv, maskEmail, maskPhone, MIN_RETENTION_DAYS } from '../server/audit.js';

let app, base;
before(async () => {
  app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const api = (path, { method = 'GET', cookie, json, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537' } = {}) => fetch(base + path, {
  method, headers: { 'User-Agent': ua, ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined,
});
async function login(userId, company = 'acme', password = DEMO_PASSWORD) {
  const r = await api('/api/auth/login', { method: 'POST', json: { company, userId, password } });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const user = (l, code = 'acme') => app.db.prepare('SELECT u.id, u.tenant_id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.login_id = ? AND t.code = ?').get(l, code);
const rows = (where = '1=1', ...a) => app.db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all(...a);

test('login events are recorded with actor, ip, device and a request id; failures are marked', async () => {
  await login('kim', 'acme', 'wrong-password');
  await login('kim');
  const r = rows("actor = 'kim' AND category = 'security'");
  const fail = r.find((x) => x.event === 'login_fail'), ok = r.find((x) => x.event === 'login_ok');
  assert.equal(fail.ok, 0); assert.match(fail.summary, /비밀번호 오류/); assert.equal(ok.ok, 1);
  assert.equal(ok.actor_name, '김하늘'); assert.match(ok.ip, /127\.0\.0\.1/); assert.match(ok.ua, /Chrome/); assert.match(ok.req, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(r).includes('wrong-password'), 'the typed password is never stored');
});

test('unknown company is recorded but belongs to no company (admins cannot see it)', async () => {
  await api('/api/auth/login', { method: 'POST', json: { company: 'zzz', userId: 'x', password: 'y' } });
  const r = rows("summary LIKE '%없는 회사 코드%'"); assert.equal(r.length, 1); assert.equal(r[0].tenant_id, null);
});

test('entries cannot be changed, and recent ones cannot be deleted', () => {
  const id = record(app.db, { category: 'security', event: 'probe', userId: user('kim').id, summary: 'x' });
  assert.throws(() => app.db.prepare('UPDATE audit_log SET summary = ? WHERE id = ?').run('edited', id), /append-only/);
  assert.throws(() => app.db.prepare('DELETE FROM audit_log WHERE id = ?').run(id), /kept for/);
  assert.throws(() => app.db.prepare('DELETE FROM audit_log').run(), /kept for/);
  assert.equal(app.db.prepare('SELECT summary FROM audit_log WHERE id = ?').get(id).summary, 'x');
});

test('retention: at least 3 years; only older entries are removed by the purge', () => {
  assert.equal(MIN_RETENTION_DAYS, 1095);
  assert.equal(retentionDays({ IAS_AUDIT_RETENTION_DAYS: '30' }), 1095, 'cannot be set below 3 years');
  assert.equal(retentionDays({ IAS_AUDIT_RETENTION_DAYS: '2000' }), 2000);
  assert.equal(retentionDays({}), 1095);
  const kim = user('kim');
  const old = record(app.db, { category: 'data', event: 'old', userId: kim.id, at: now() - 1200 * 86400 });
  const mid = record(app.db, { category: 'data', event: 'mid', userId: kim.id, at: now() - 1000 * 86400 });
  assert.ok(purgeExpired(app.db) >= 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM audit_log WHERE id = ?').get(old).n, 0, '1200 days old: removed');
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM audit_log WHERE id = ?').get(mid).n, 1, '1000 days old: kept');
  assert.throws(() => app.db.prepare('DELETE FROM audit_log WHERE id = ?').run(mid), /kept for/);
});

test('record() rules: known category, secrets removed, actor stays readable after the account is deleted', () => {
  assert.throws(() => record(app.db, { category: 'nope', event: 'x' }), /unknown category/);
  assert.throws(() => record(app.db, { category: 'data' }), /event is required/);
  assert.deepEqual(sanitize({ title: 'a', password: 'p', nested: { apiToken: 't', ok: 1 }, cookie: 'c' }), { title: 'a', password: '[숨김]', nested: { apiToken: '[숨김]', ok: 1 }, cookie: '[숨김]' });
  const tmp = app.db.prepare("INSERT INTO users (tenant_id, login_id, name, pw_hash, created_at) VALUES (?, 'temp', '임시', 'x', ?)").run(user('kim').tenant_id, now());
  const id = record(app.db, { category: 'data', event: 'post.created', app: 'board', userId: Number(tmp.lastInsertRowid), target: { type: 'post', id: 12 }, summary: '게시글 작성: 안녕', data: { title: '안녕', password: 'zzz' } });
  app.db.prepare('DELETE FROM users WHERE id = ?').run(Number(tmp.lastInsertRowid));
  const r = app.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  assert.equal(r.actor, 'temp'); assert.equal(r.actor_name, '임시'); assert.equal(r.target_type, 'post'); assert.equal(r.target_id, '12'); assert.equal(r.app, 'board');
  assert.ok(!r.data.includes('zzz'));
});

test('masking helpers', () => {
  assert.equal(maskEmail('haneul@acme.example'), 'h***@acme.example');
  assert.equal(maskPhone('010-2222-3333'), '010-****-3333'); assert.equal(maskPhone(''), ''); assert.equal(maskEmail(null), '');
});

test('profile edits are logged with masked before/after only when something changed', async () => {
  const c = await login('admin');
  const n0 = rows("event = 'profile_updated'").length;
  await api('/api/me/profile', { method: 'PUT', cookie: c, json: { email: 'admin@acme.example', phone: '' } }); // unchanged
  assert.equal(rows("event = 'profile_updated'").length, n0);
  await api('/api/me/profile', { method: 'PUT', cookie: c, json: { email: 'boss@acme.example', phone: '010-1111-2222' } });
  const e = rows("event = 'profile_updated'").pop(); const d = JSON.parse(e.data);
  assert.equal(e.category, 'data'); assert.equal(e.target_type, 'user'); assert.deepEqual(d.email, { from: 'a***@acme.example', to: 'b***@acme.example' }); assert.deepEqual(d.phone, { from: '', to: '010-****-2222' });
  assert.ok(!e.data.includes('boss@') && !e.data.includes('1111-2222'));
});

test('password change, other-device logout and device notifications are recorded (notification toggle only on real change)', async () => {
  const c = await login('newbie', 'daehan'); await login('newbie', 'daehan');
  await api('/api/me/sessions/logout-others', { method: 'POST', cookie: c, json: {} });
  assert.ok(rows("event = 'sessions_revoked_others'").length >= 1);
  await api('/api/auth/change-password', { method: 'POST', cookie: c, json: { current: DEMO_PASSWORD, next: 'Newpass123' } });
  const pw = rows("event = 'password_changed'").pop(); assert.equal(pw.actor, 'newbie'); assert.ok(!JSON.stringify(pw).includes('Newpass123'));
  const crypto = await import('node:crypto'); const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const sub = { endpoint: 'https://push.example.com/send/audit-1', keys: { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const n0 = rows("event = 'device_notify_on'").length;
  for (let i = 0; i < 3; i++) await api('/api/push/subscribe', { method: 'POST', cookie: c, json: sub }); // page loads keep re-sending it
  assert.equal(rows("event = 'device_notify_on'").length, n0 + 1);
  await api('/api/push/unsubscribe', { method: 'POST', cookie: c, json: { endpoint: sub.endpoint } });
  assert.equal(rows("event = 'device_notify_off'").length, 1);
});

test('admin API: only people with the audit permission, only their own company, filters and paging', async () => {
  const kim = await login('kim'), adminC = await login('admin'), adminD = await login('admin', 'daehan');
  assert.equal((await api('/api/admin/audit', { cookie: kim })).status, 403);
  assert.equal((await api('/api/admin/audit')).status, 401);
  const all = await (await api('/api/admin/audit?limit=500', { cookie: adminC })).json();
  assert.ok(all.items.length > 5);
  const acmeId = user('admin').tenant_id;
  assert.ok(all.items.every((x) => rows('id = ?', x.id)[0].tenant_id === acmeId), 'no other company rows');
  const other = await (await api('/api/admin/audit?limit=500', { cookie: adminD })).json();
  assert.ok(!other.items.some((x) => all.items.some((y) => y.id === x.id)), 'companies are separate');
  const sec = await (await api('/api/admin/audit?category=data&limit=200', { cookie: adminC })).json();
  assert.ok(sec.items.length > 0 && sec.items.every((x) => x.category === 'data'));
  const q = await (await api('/api/admin/audit?q=' + encodeURIComponent('비밀번호 오류'), { cookie: adminC })).json();
  assert.ok(q.items.length >= 1 && q.items.every((x) => /비밀번호 오류|kim/.test(JSON.stringify(x))));
  const page1 = await (await api('/api/admin/audit?limit=3', { cookie: adminC })).json();
  assert.equal(page1.items.length, 3); assert.equal(page1.hasMore, true);
  const page2 = await (await api(`/api/admin/audit?limit=3&before=${page1.items[2].id}`, { cookie: adminC })).json();
  assert.ok(page2.items.every((x) => x.id < page1.items[2].id));
  const future = await (await api(`/api/admin/audit?from=${now() + 3600}`, { cookie: adminC })).json(); assert.equal(future.items.length, 0);
  assert.equal((await (await api('/api/admin/audit?q=%25', { cookie: adminC })).json()).items.length, 0, '% is searched literally');
});

test('CSV export: BOM, Korean headers, spreadsheet formulas neutralised, and the export itself is logged', async () => {
  const adminC = await login('admin');
  record(app.db, { category: 'data', event: 'x', userId: user('admin').id, summary: '=HYPERLINK("http://evil","x")' });
  const r = await api('/api/admin/audit.csv', { cookie: adminC });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/); assert.match(r.headers.get('content-disposition'), /attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"/);
  const bytes = Buffer.from(await r.arrayBuffer()); const text = bytes.toString('utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel shows Korean correctly'); assert.match(text, /^\ufeff"id","시각","구분"/);
  assert.ok(text.includes(`"'=HYPERLINK(`)); assert.ok(!text.includes(',"=HYPERLINK'));
  assert.equal((await api('/api/admin/audit.csv', { cookie: await login('kim') })).status, 403);
  const exp = rows("event = 'audit_exported'").pop(); assert.equal(exp.category, 'admin'); assert.match(exp.summary, /CSV/);
  assert.match(toCsv([{ id: 1, at: 0, category: 'security', event: 'e', ok: false, summary: 'a"b' }]), /"a""b"/);
});

test('an existing database gets the new columns and protection', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(audit_log)').all().map((c) => c.name);
  for (const c of ['category', 'actor', 'actor_name', 'summary', 'data', 'req', 'ok']) assert.ok(cols.includes(c), c);
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((x) => x.name);
  assert.ok(t.includes('audit_no_update') && t.includes('audit_no_delete'));
});
