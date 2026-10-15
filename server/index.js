import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { openDb, now, seedDemo, effectivePermissions, DEMO_PASSWORD } from './db.js';
import { listFor, markRead, markAllRead, purgeOld, notify, onNotify } from './notifications.js';
import { loadVapid, sendPush, validSubscription } from './push.js';
import { can } from './db.js';
import { profileOf, updateContact, photoMime, savePhoto, getPhoto, deletePhoto, getSettings, updateSettings, uaLabel, PHOTO_MAX } from './profile.js';
import { appsFor, catalogFor } from './apps.js';
import './modules.js';
import { cleanLayout, saveLayout, resetLayout, layoutFor } from './layout.js';
import { asUser, searchChanges, changesToCsv, purgeChanges } from './changelog.js';
import { record, runWithContext, search as auditSearch, toCsv, purgeExpired, maskEmail, maskPhone, CATEGORIES } from './audit.js';
import { hashPassword, verifyPassword, DUMMY_HASH, newToken, sha256, parseCookies, cookie, passwordProblem } from './security.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'ias_sid';
const MAX_FAILS = 5, LOCK_SEC = 300;
const SESSION_SEC = 12 * 3600, REMEMBER_SEC = 30 * 24 * 3600;
const IP_FAILS = 30, IP_WINDOW = 600;

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; } }

export function createApp({ dbFile = join(ROOT, 'data', 'ias.db'), secure = false, trustProxy = false, seed = true, pushFetch = fetch, pushSubject = process.env.IAS_PUSH_SUBJECT || 'mailto:admin@example.com' } = {}) {
  const db = openDb(dbFile);
  const seeded = seed ? seedDemo(db) : false;
  const ipFails = new Map(); // ip -> [timestamps]
  const vapid = loadVapid(db);
  if (seeded) { // dev only: a couple of system notices for the demo accounts
    const t = now();
    for (const u of db.prepare("SELECT id, tenant_id FROM users WHERE login_id IN ('kim', 'admin')").all()) {
      notify(db, { tenantId: u.tenant_id, userId: u.id, source: '시스템', title: '새 기기에서 로그인했습니다', body: 'Chrome · Windows', at: t - 26 * 3600 });
      notify(db, { tenantId: u.tenant_id, userId: u.id, source: '시스템', title: '비밀번호 변경 안내', body: '90일이 지났습니다. 비밀번호를 변경해 주세요', link: 'change-password.html', at: t - 95 * 60 });
    }
  }

  // Device notifications: every stored notification is also pushed to the user's devices.
  const pending = new Set();
  const offNotify = onNotify((ndb, n) => {
    if (ndb !== db) return;
    if (n.app !== null && !can(effectivePermissions(db, n.userId), 'app', n.app)) return; // cannot use that app: no push either
    for (const sub of q.subs.all(n.userId)) {
      const job = sendPush(sub, { id: n.id, source: n.source, title: n.title, body: n.body, link: n.link }, { vapid, subject: pushSubject, fetchImpl: pushFetch })
        .then((r) => { if (r.gone) q.subDelAny.run(sub.endpoint); })
        .catch(() => {})
        .finally(() => pending.delete(job));
      pending.add(job);
    }
  });
  purgeOld(db); purgeExpired(db); purgeChanges(db);
  const purgeTimer = setInterval(() => { try { purgeOld(db); purgeExpired(db); purgeChanges(db); } catch (e) { console.error(e); } }, 6 * 3600 * 1000);
  purgeTimer.unref();

  const q = {
    tenantByCode: db.prepare("SELECT id, code, name FROM tenants WHERE code = ? AND status = 'active'"),
    tenants: db.prepare("SELECT code, name FROM tenants WHERE status = 'active' AND (name LIKE ? OR code LIKE ?) ORDER BY name LIMIT 100"),
    userByLogin: db.prepare('SELECT * FROM users WHERE tenant_id = ? AND login_id = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    roles: db.prepare('SELECT r.key, r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?'),
    fail: db.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?'),
    ok: db.prepare('UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?'),
    newSession: db.prepare('INSERT INTO sessions (id_hash, user_id, tenant_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT * FROM sessions WHERE id_hash = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    delOther: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?'),
    mySessions: db.prepare('SELECT rowid AS id, id_hash, ua, created_at FROM sessions WHERE user_id = ? AND expires_at >= ? ORDER BY created_at DESC, rowid DESC'),
    delSessionById: db.prepare('DELETE FROM sessions WHERE rowid = ? AND user_id = ? AND id_hash != ?'),
    photoUser: db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    tenantById: db.prepare('SELECT id, code, name FROM tenants WHERE id = ?'),
    setPw: db.prepare('UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?'),
    subs: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?'),
    subCount: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?'),
    subUpsert: db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua'),
    subDel: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?'),
    subDelAny: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
  };
  // ip, user agent and request id come from the request context (runWithContext below)
  const audit = (event, { category = 'security', tenantId = null, userId = null, ok = true, summary = null, data, app = null, target } = {}) =>
    record(db, { category, event, tenantId, userId, ok, summary, data, app, target });

  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '';
  const isSecure = (req) => secure || req.headers['x-forwarded-proto'] === 'https';

  function ipBlocked(ip) {
    const t = now(), arr = (ipFails.get(ip) || []).filter((x) => x > t - IP_WINDOW);
    ipFails.set(ip, arr);
    return arr.length >= IP_FAILS;
  }
  const ipFail = (ip) => { const a = ipFails.get(ip) || []; a.push(now()); ipFails.set(ip, a); };

  function send(res, status, body, headers = {}) {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
    });
    res.end(isObj ? JSON.stringify(body) : body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0, tooBig = false; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 10240) tooBig = true; else chunks.push(c); });
      req.on('end', () => {
        if (tooBig) return reject(new HttpError(413, 'TOO_LARGE'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new HttpError(400, 'BAD_JSON')); }
      });
      req.on('error', reject);
    });
  }

  // CSRF: SameSite=Lax cookie + JSON content type + same-origin Origin header
  function checkPost(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED');
    const origin = req.headers.origin;
    if (origin) {
      const proto = isSecure(req) ? 'https' : 'http';
      if (origin !== `${proto}://${req.headers.host}`) throw new HttpError(403, 'BAD_ORIGIN');
    }
  }

  function readBuffer(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0, tooBig = false; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > max) tooBig = true; else chunks.push(c); });
      req.on('end', () => (tooBig ? reject(new HttpError(413, 'TOO_LARGE')) : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }
  function checkImage(req) { // raw image upload: same-origin only, image content types only
    if (!/^image\/(jpeg|png|webp)(;|$)/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'IMAGE_REQUIRED');
    const origin = req.headers.origin;
    if (origin && origin !== `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`) throw new HttpError(403, 'BAD_ORIGIN');
  }
  function sendPhoto(req, res, userId) {
    const p = getPhoto(db, userId);
    if (!p) throw new HttpError(404, 'NO_PHOTO');
    const etag = `"${p.updated_at}-${p.data.length}"`;
    const headers = { 'Content-Type': p.mime, 'Cache-Control': 'private, no-cache', ETag: etag, 'Content-Security-Policy': "default-src 'none'; sandbox" };
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
    send(res, 200, Buffer.from(p.data), headers);
  }

  function currentSession(req) {
    const sid = parseCookies(req.headers.cookie)[SID];
    if (!sid) return null;
    const s = q.session.get(sha256(sid));
    if (!s) return null;
    if (s.expires_at < now()) { q.delSession.run(s.id_hash); return null; }
    const user = q.userById.get(s.user_id);
    if (!user || user.status !== 'active') { q.delSession.run(s.id_hash); return null; }
    return { s, user, sidHash: s.id_hash };
  }
  function requireSession(req) {
    const cur = currentSession(req);
    if (!cur) throw new HttpError(401, 'UNAUTHENTICATED');
    return cur;
  }

  /** The audit log is for company admins: needs the 'audit' app permission (admins have * ). */
  function requireAudit(req) {
    const cur = requireSession(req);
    if (!can(effectivePermissions(db, cur.user.id), 'app', 'audit')) throw new HttpError(403, 'FORBIDDEN');
    return cur;
  }

  function publicUser(user) {
    const tenant = q.tenantById.get(user.tenant_id);
    return { id: user.id, loginId: user.login_id, name: user.name, tenant: { code: tenant.code, name: tenant.name } };
  }

  const routes = {
    'GET /api/tenants': (req, res, url) => {
      const term = `%${(url.searchParams.get('q') || '').trim().replace(/[%_]/g, '')}%`;
      send(res, 200, q.tenants.all(term, term.toLowerCase()));
    },

    'POST /api/auth/login': async (req, res) => {
      checkPost(req);
      const ip = clientIp(req), ua = String(req.headers['user-agent'] || '').slice(0, 200);
      if (ipBlocked(ip)) throw new HttpError(429, 'TOO_MANY_REQUESTS', { retryAfter: IP_WINDOW });
      const b = await readJson(req);
      const company = typeof b.company === 'string' ? b.company.trim().toLowerCase() : '';
      const userId = typeof b.userId === 'string' ? b.userId.trim().toLowerCase() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      if (!company || !userId || !password || company.length > 64 || userId.length > 128 || password.length > 128) throw new HttpError(400, 'INVALID_INPUT');

      const tenant = q.tenantByCode.get(company);
      if (!tenant) { verifyPassword(password, DUMMY_HASH); ipFail(ip); audit('login_fail', { ok: false, summary: '로그인 실패: 없는 회사 코드', data: { company: company.slice(0, 40), loginId: userId.slice(0, 40) } }); throw new HttpError(404, 'COMPANY_NOT_FOUND'); }
      const user = q.userByLogin.get(tenant.id, userId);
      const t = now();
      if (user && user.locked_until > t) {
        throw new HttpError(423, 'LOCKED', { retryAfter: user.locked_until - t });
      }
      const good = verifyPassword(password, user ? user.pw_hash : DUMMY_HASH);
      if (!user || !good) {
        ipFail(ip);
        if (user) {
          const n = user.failed_count + 1;
          if (n >= MAX_FAILS) { q.fail.run(0, t + LOCK_SEC, user.id); audit('login_locked', { tenantId: tenant.id, userId: user.id, ok: false, summary: `비밀번호를 ${MAX_FAILS}번 틀려 계정이 ${LOCK_SEC / 60}분간 잠겼습니다` }); throw new HttpError(423, 'LOCKED', { retryAfter: LOCK_SEC }); }
          q.fail.run(n, 0, user.id);
        }
        audit('login_fail', { tenantId: tenant.id, userId: user?.id ?? null, ok: false, summary: user ? '로그인 실패: 비밀번호 오류' : '로그인 실패: 없는 아이디', data: user ? undefined : { loginId: userId.slice(0, 40) } });
        throw new HttpError(401, 'INVALID_CREDENTIALS');
      }
      if (user.status !== 'active') { audit('login_disabled', { tenantId: tenant.id, userId: user.id, ok: false, summary: '사용이 중지된 계정으로 로그인 시도' }); throw new HttpError(403, 'ACCOUNT_DISABLED'); }

      q.ok.run(user.id);
      const sid = newToken(), ttl = b.remember === true ? REMEMBER_SEC : SESSION_SEC;
      q.purge.run(t);
      q.newSession.run(sha256(sid), user.id, tenant.id, t, t + ttl, ip, ua);
      audit('login_ok', { tenantId: tenant.id, userId: user.id, summary: '로그인' });
      send(res, 200, { user: publicUser(user), mustChangePassword: !!user.must_change_pw },
        { 'Set-Cookie': cookie(SID, sid, { maxAge: b.remember === true ? REMEMBER_SEC : undefined, secure: isSecure(req) }) });
    },

    'POST /api/auth/logout': (req, res) => {
      checkPost(req);
      const cur = currentSession(req);
      if (cur) { q.delSession.run(cur.sidHash); audit('logout', { tenantId: cur.s.tenant_id, userId: cur.user.id, summary: '로그아웃' }); }
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie(SID, '', { maxAge: 0, secure: isSecure(req) }) });
    },

    'GET /api/auth/me': (req, res) => {
      const { user } = requireSession(req);
      const permissions = effectivePermissions(db, user.id);
      send(res, 200, { user: profileOf(db, user, q.tenantById.get(user.tenant_id)), mustChangePassword: !!user.must_change_pw,
        roles: q.roles.all(user.id), permissions, settings: getSettings(db, user.id), apps: appsFor(permissions), catalog: catalogFor(permissions) });
    },

    'PUT /api/me/profile': async (req, res) => {
      checkPost(req);
      const { user } = requireSession(req);
      const body = await readJson(req);
      const err = asUser(db, user, () => updateContact(db, user.id, body));
      if (err) throw new HttpError(400, err);
      const after = q.userById.get(user.id), change = {};
      if ((user.email || '') !== (after.email || '')) change.email = { from: maskEmail(user.email), to: maskEmail(after.email) };
      if ((user.phone || '') !== (after.phone || '')) change.phone = { from: maskPhone(user.phone), to: maskPhone(after.phone) };
      if (Object.keys(change).length) audit('profile_updated', { category: 'data', tenantId: user.tenant_id, userId: user.id, target: { type: 'user', id: user.id }, summary: `내 정보 수정: ${Object.keys(change).map((k) => (k === 'email' ? '이메일' : '전화번호')).join(', ')}`, data: change });
      send(res, 200, profileOf(db, q.userById.get(user.id), q.tenantById.get(user.tenant_id)));
    },

    'GET /api/me/layout': (req, res) => {
      const { user } = requireSession(req);
      const catalog = catalogFor(effectivePermissions(db, user.id));
      send(res, 200, { catalog, layout: layoutFor(db, user.id, catalog) });
    },

    'PUT /api/me/layout': async (req, res) => {
      checkPost(req);
      const { user } = requireSession(req);
      const clean = cleanLayout(await readJson(req));
      if (!clean) throw new HttpError(400, 'INVALID_LAYOUT');
      saveLayout(db, user.id, clean);
      const catalog = catalogFor(effectivePermissions(db, user.id));
      send(res, 200, { catalog, layout: layoutFor(db, user.id, catalog) });
    },

    'POST /api/me/layout/reset': (req, res) => {
      checkPost(req);
      const { user } = requireSession(req);
      resetLayout(db, user.id);
      const catalog = catalogFor(effectivePermissions(db, user.id));
      send(res, 200, { catalog, layout: layoutFor(db, user.id, catalog) });
    },

    'GET /api/me/settings': (req, res) => { const { user } = requireSession(req); send(res, 200, getSettings(db, user.id)); },

    'PUT /api/me/settings': async (req, res) => {
      checkPost(req);
      const { user } = requireSession(req);
      const body = await readJson(req);
      const err = asUser(db, user, () => updateSettings(db, user.id, body));
      if (err) throw new HttpError(400, err);
      send(res, 200, getSettings(db, user.id));
    },

    'GET /api/me/photo': (req, res) => { const { user } = requireSession(req); sendPhoto(req, res, user.id); },

    'POST /api/me/photo': async (req, res) => {
      checkImage(req);
      const { user } = requireSession(req);
      const buf = await readBuffer(req, PHOTO_MAX);
      const mime = photoMime(buf);
      if (!mime || mime !== req.headers['content-type'].split(';')[0]) throw new HttpError(400, 'INVALID_IMAGE');
      asUser(db, user, () => savePhoto(db, user.id, mime, buf));
      audit('photo_changed', { category: 'data', tenantId: user.tenant_id, userId: user.id, target: { type: 'user', id: user.id }, summary: '프로필 사진 변경', data: { bytes: buf.length, mime } });
      send(res, 200, profileOf(db, user, q.tenantById.get(user.tenant_id)));
    },

    'POST /api/me/photo/delete': (req, res) => {
      checkPost(req);
      const { user } = requireSession(req);
      if (asUser(db, user, () => deletePhoto(db, user.id))) audit('photo_removed', { category: 'data', tenantId: user.tenant_id, userId: user.id, target: { type: 'user', id: user.id }, summary: '프로필 사진 삭제' });
      send(res, 200, profileOf(db, user, q.tenantById.get(user.tenant_id)));
    },

    'GET /api/me/sessions': (req, res) => {
      const { user, sidHash } = requireSession(req);
      send(res, 200, q.mySessions.all(user.id, now()).map((s) => ({ id: Number(s.id), device: uaLabel(s.ua), createdAt: s.created_at, current: s.id_hash === sidHash })));
    },

    'POST /api/me/sessions/logout-others': (req, res) => {
      checkPost(req);
      const { user, sidHash } = requireSession(req);
      const removed = Number(q.delOther.run(user.id, sidHash).changes);
      if (removed) audit('sessions_revoked_others', { tenantId: user.tenant_id, userId: user.id, summary: `다른 기기 ${removed}대에서 로그아웃`, data: { removed } });
      send(res, 200, { removed });
    },

    'GET /api/notifications': (req, res, url) => {
      const { user } = requireSession(req);
      const filter = url.searchParams.get('filter') === 'unread' ? 'unread' : 'all';
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 50, 1), 100);
      send(res, 200, listFor(db, user.id, { filter, limit }));
    },

    'POST /api/notifications/read-all': (req, res) => {
      checkPost(req);
      const { user } = requireSession(req);
      send(res, 200, { updated: markAllRead(db, user.id) });
    },

    'GET /api/push/key': (req, res) => { requireSession(req); send(res, 200, { publicKey: vapid.publicKey }); },

    'POST /api/push/subscribe': async (req, res) => {
      checkPost(req);
      const { user } = requireSession(req);
      const b = await readJson(req);
      if (!validSubscription(b)) throw new HttpError(400, 'INVALID_SUBSCRIPTION');
      if (q.subCount.get(user.id).n >= 10 && !q.subs.all(user.id).some((s) => s.endpoint === b.endpoint)) throw new HttpError(400, 'TOO_MANY_DEVICES');
      const prev = db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(b.endpoint);
      q.subUpsert.run(user.id, b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] || '').slice(0, 200), now()); // a device that changes user is re-assigned
      if (!prev || prev.user_id !== user.id) audit('device_notify_on', { tenantId: user.tenant_id, userId: user.id, summary: '기기 알림 켜기', data: { device: uaLabel(String(req.headers['user-agent'] || '')) } });
      send(res, 200, { ok: true });
    },

    'POST /api/push/unsubscribe': async (req, res) => {
      checkPost(req);
      const { user } = requireSession(req);
      const b = await readJson(req);
      if (typeof b.endpoint !== 'string') throw new HttpError(400, 'INVALID_INPUT');
      const removed = Number(q.subDel.run(b.endpoint, user.id).changes);
      if (removed) audit('device_notify_off', { tenantId: user.tenant_id, userId: user.id, summary: '기기 알림 끄기', data: { device: uaLabel(String(req.headers['user-agent'] || '')) } });
      send(res, 200, { removed });
    },

    'GET /api/admin/audit': (req, res, url) => {
      const { user } = requireAudit(req);
      const p = url.searchParams;
      send(res, 200, auditSearch(db, user.tenant_id, { from: p.get('from'), to: p.get('to'), category: p.get('category'), q: p.get('q'), before: p.get('before'), limit: Math.min(Number(p.get('limit')) || 100, 200) }));
    },

    'GET /api/admin/changes': (req, res, url) => {
      const { user } = requireAudit(req);
      const p = url.searchParams;
      send(res, 200, searchChanges(db, user.tenant_id, { from: p.get('from'), to: p.get('to'), q: p.get('q'), table: p.get('table'), before: p.get('before'), limit: Math.min(Number(p.get('limit')) || 100, 200) }));
    },

    'GET /api/admin/changes.csv': (req, res, url) => {
      const { user } = requireAudit(req);
      const p = url.searchParams;
      const { items } = searchChanges(db, user.tenant_id, { from: p.get('from'), to: p.get('to'), q: p.get('q'), table: p.get('table'), limit: 50000 });
      audit('changes_exported', { category: 'admin', tenantId: user.tenant_id, userId: user.id, summary: `변경 기록 CSV 내려받기 (${items.length}건)`, data: { rows: items.length, q: p.get('q'), from: p.get('from'), to: p.get('to') } });
      send(res, 200, Buffer.from(changesToCsv(items), 'utf8'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="changes-${new Date().toISOString().slice(0, 10)}.csv"` });
    },

    'GET /api/admin/audit.csv': (req, res, url) => {
      const { user } = requireAudit(req);
      const p = url.searchParams;
      const { items } = auditSearch(db, user.tenant_id, { from: p.get('from'), to: p.get('to'), category: p.get('category'), q: p.get('q'), limit: 50000 });
      audit('audit_exported', { category: 'admin', tenantId: user.tenant_id, userId: user.id, summary: `감사 로그 CSV 내려받기 (${items.length}건)`, data: { rows: items.length, category: p.get('category'), from: p.get('from'), to: p.get('to'), q: p.get('q') } });
      send(res, 200, Buffer.from(toCsv(items), 'utf8'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"` });
    },

    'POST /api/auth/change-password': async (req, res) => {
      checkPost(req);
      const { user, sidHash } = requireSession(req);
      const b = await readJson(req);
      if (typeof b.current !== 'string' || typeof b.next !== 'string') throw new HttpError(400, 'INVALID_INPUT');
      if (!verifyPassword(b.current, user.pw_hash)) throw new HttpError(401, 'INVALID_CREDENTIALS');
      const problem = passwordProblem(b.next);
      if (problem) throw new HttpError(400, 'WEAK_PASSWORD', { message: problem });
      if (b.next === b.current) throw new HttpError(400, 'SAME_PASSWORD');
      const newHash = hashPassword(b.next);
      asUser(db, user, () => q.setPw.run(newHash, user.id));
      q.delOther.run(user.id, sidHash); // sign out every other device
      audit('password_changed', { tenantId: user.tenant_id, userId: user.id, summary: '비밀번호 변경 (다른 기기는 모두 로그아웃)' });
      send(res, 200, { ok: true });
    },
  };

  async function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const norm = normalize(p).replace(/^([/\\])+/, '');
    const ok = /^[\w.-]+\.html$/.test(norm) || norm === 'sw.js' || /^(css|js)([/\\][\w.-]+)?[/\\][\w.-]+\.(css|js)$/.test(norm);
    if (!ok || norm.split(sep).includes('..')) return send(res, 404, 'Not found');
    try {
      const buf = await readFile(join(ROOT, norm));
      send(res, 200, buf, { 'Content-Type': MIME[extname(norm)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    } catch { send(res, 404, 'Not found'); }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://x');
      return await runWithContext({ ip: clientIp(req), ua: String(req.headers['user-agent'] || '') }, async () => {
      if (url.pathname.startsWith('/api/')) {
        let m = req.method === 'POST' && url.pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
        if (m) {
          checkPost(req);
          const { user } = requireSession(req);
          return send(res, 200, { updated: markRead(db, user.id, Number(m[1])) });
        }
        m = req.method === 'POST' && url.pathname.match(/^\/api\/me\/sessions\/(\d+)\/logout$/);
        if (m) {
          checkPost(req);
          const { user, sidHash } = requireSession(req);
          const removed = Number(q.delSessionById.run(Number(m[1]), user.id, sidHash).changes);
          if (removed) audit('session_revoked', { tenantId: user.tenant_id, userId: user.id, summary: '다른 기기 1대에서 로그아웃', target: { type: 'session', id: m[1] } });
          return send(res, 200, { removed });
        }
        m = req.method === 'GET' && url.pathname.match(/^\/api\/users\/(\d+)\/photo$/);
        if (m) { // co-workers' photos: same company only
          const { user } = requireSession(req);
          if (!q.photoUser.get(Number(m[1]), user.tenant_id)) throw new HttpError(404, 'NO_PHOTO');
          return sendPhoto(req, res, Number(m[1]));
        }
        const h = routes[`${req.method} ${url.pathname}`];
        if (!h) throw new HttpError(404, 'NOT_FOUND');
        return await h(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      await serveStatic(req, res, url);
      });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { code: e.code, ...(e.extra || {}) });
      console.error(e);
      send(res, 500, { code: 'UNKNOWN' });
    }
  });

  return { server, db, seeded, notify: (n) => notify(db, n), flushPush: () => Promise.allSettled([...pending]), close: () => { offNotify(); clearInterval(purgeTimer); server.close(); db.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ dbFile: process.env.IAS_DB || undefined, secure: process.env.IAS_SECURE === '1', trustProxy: process.env.IAS_TRUST_PROXY === '1', seed: process.env.IAS_SEED_DEMO !== '0' });
  app.server.listen(port, () => {
    console.log(`IAS server: http://localhost:${port}`);
    if (app.seeded) console.log(`개발용 데모 계정을 만들었습니다. 회사 acme / 아이디 admin, kim, newbie(첫 로그인 비밀번호 변경) / 비밀번호 ${DEMO_PASSWORD}`);
  });
}
