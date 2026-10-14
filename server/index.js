import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { openDb, now, seedDemo, effectivePermissions, DEMO_PASSWORD } from './db.js';
import { hashPassword, verifyPassword, DUMMY_HASH, newToken, sha256, parseCookies, cookie, passwordProblem } from './security.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'ias_sid';
const MAX_FAILS = 5, LOCK_SEC = 300;
const SESSION_SEC = 12 * 3600, REMEMBER_SEC = 30 * 24 * 3600;
const IP_FAILS = 30, IP_WINDOW = 600;

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; } }

export function createApp({ dbFile = join(ROOT, 'data', 'ias.db'), secure = false, trustProxy = false, seed = true } = {}) {
  const db = openDb(dbFile);
  const seeded = seed ? seedDemo(db) : false;
  const ipFails = new Map(); // ip -> [timestamps]

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
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    tenantById: db.prepare('SELECT id, code, name FROM tenants WHERE id = ?'),
    setPw: db.prepare('UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?'),
    audit: db.prepare('INSERT INTO audit_log (at, tenant_id, user_id, event, ip, detail) VALUES (?, ?, ?, ?, ?, ?)'),
  };
  const audit = (event, { tenantId = null, userId = null, ip = null, detail = null } = {}) => q.audit.run(now(), tenantId, userId, event, ip, detail);

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
      if (!tenant) { verifyPassword(password, DUMMY_HASH); ipFail(ip); throw new HttpError(404, 'COMPANY_NOT_FOUND'); }
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
          if (n >= MAX_FAILS) { q.fail.run(0, t + LOCK_SEC, user.id); audit('login_locked', { tenantId: tenant.id, userId: user.id, ip }); throw new HttpError(423, 'LOCKED', { retryAfter: LOCK_SEC }); }
          q.fail.run(n, 0, user.id);
        }
        audit('login_fail', { tenantId: tenant.id, userId: user?.id ?? null, ip, detail: user ? null : 'unknown_user' });
        throw new HttpError(401, 'INVALID_CREDENTIALS');
      }
      if (user.status !== 'active') { audit('login_disabled', { tenantId: tenant.id, userId: user.id, ip }); throw new HttpError(403, 'ACCOUNT_DISABLED'); }

      q.ok.run(user.id);
      const sid = newToken(), ttl = b.remember === true ? REMEMBER_SEC : SESSION_SEC;
      q.purge.run(t);
      q.newSession.run(sha256(sid), user.id, tenant.id, t, t + ttl, ip, ua);
      audit('login_ok', { tenantId: tenant.id, userId: user.id, ip });
      send(res, 200, { user: publicUser(user), mustChangePassword: !!user.must_change_pw },
        { 'Set-Cookie': cookie(SID, sid, { maxAge: b.remember === true ? REMEMBER_SEC : undefined, secure: isSecure(req) }) });
    },

    'POST /api/auth/logout': (req, res) => {
      checkPost(req);
      const cur = currentSession(req);
      if (cur) { q.delSession.run(cur.sidHash); audit('logout', { tenantId: cur.s.tenant_id, userId: cur.user.id, ip: clientIp(req) }); }
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie(SID, '', { maxAge: 0, secure: isSecure(req) }) });
    },

    'GET /api/auth/me': (req, res) => {
      const { user } = requireSession(req);
      send(res, 200, { user: publicUser(user), mustChangePassword: !!user.must_change_pw,
        roles: q.roles.all(user.id), permissions: effectivePermissions(db, user.id) });
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
      q.setPw.run(hashPassword(b.next), user.id);
      q.delOther.run(user.id, sidHash); // sign out every other device
      audit('password_changed', { tenantId: user.tenant_id, userId: user.id, ip: clientIp(req) });
      send(res, 200, { ok: true });
    },
  };

  async function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const norm = normalize(p).replace(/^([/\\])+/, '');
    const ok = /^[\w.-]+\.html$/.test(norm) || /^(css|js)[/\\][\w.-]+\.(css|js)$/.test(norm);
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
      if (url.pathname.startsWith('/api/')) {
        const h = routes[`${req.method} ${url.pathname}`];
        if (!h) throw new HttpError(404, 'NOT_FOUND');
        return await h(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      await serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { code: e.code, ...(e.extra || {}) });
      console.error(e);
      send(res, 500, { code: 'UNKNOWN' });
    }
  });

  return { server, db, seeded, close: () => { server.close(); db.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ dbFile: process.env.IAS_DB || undefined, secure: process.env.IAS_SECURE === '1', trustProxy: process.env.IAS_TRUST_PROXY === '1', seed: process.env.IAS_SEED_DEMO !== '0' });
  app.server.listen(port, () => {
    console.log(`IAS server: http://localhost:${port}`);
    if (app.seeded) console.log(`개발용 데모 계정을 만들었습니다. 회사 acme / 아이디 admin, kim, newbie(첫 로그인 비밀번호 변경) / 비밀번호 ${DEMO_PASSWORD}`);
  });
}
