import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashPassword } from './security.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  login_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
  pw_hash TEXT NOT NULL, must_change_pw INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  failed_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, UNIQUE (tenant_id, login_id)
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL, name TEXT NOT NULL, UNIQUE (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
-- role grants: kind is 'app' or 'widget'; resource '*' means all
CREATE TABLE IF NOT EXISTS role_grants (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('app','widget')), resource TEXT NOT NULL,
  PRIMARY KEY (role_id, kind, resource)
);
-- per-user exceptions: allow=1 adds, allow=0 removes (wins over roles)
CREATE TABLE IF NOT EXISTS user_grants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('app','widget')), resource TEXT NOT NULL, allow INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, resource)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- notifications: app = permission resource id (NULL = system, always visible), source = label shown to the user
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app TEXT, source TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT,
  created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS user_photos (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, mime TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- one row per browser/device that turned on device notifications (Web Push)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, tenant_id INTEGER, user_id INTEGER, event TEXT NOT NULL, ip TEXT, detail TEXT
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // columns added after the first release (existing databases)
  const have = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  for (const col of ['phone', 'department', 'job_title']) if (!have.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  return db;
}

export const now = () => Math.floor(Date.now() / 1000);

/** Development seed: companies, roles and a few demo accounts. Never used when IAS_SEED_DEMO=0. */
export const DEMO_PASSWORD = 'Demo1234!';
export function seedDemo(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n > 0) return false;
  const tenants = [['acme', '에이씨엠이 주식회사'], ['daehan', '대한물산'], ['hanbit', '한빛정보통신'], ['sunrise', '선라이즈 테크'],
    ['myeongin', '명인식품'], ['nuri', '누리건설'], ['bluesea', '블루씨 로지스틱스'], ['greenfield', '그린필드 에너지'],
    ['hana', '하나메디칼'], ['onda', '온다 미디어']];
  const insT = db.prepare('INSERT INTO tenants (code, name) VALUES (?, ?)');
  const insR = db.prepare('INSERT INTO roles (tenant_id, key, name) VALUES (?, ?, ?)');
  const insG = db.prepare('INSERT INTO role_grants (role_id, kind, resource) VALUES (?, ?, ?)');
  const insU = db.prepare('INSERT INTO users (tenant_id, login_id, name, pw_hash, must_change_pw, created_at, department, job_title, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insUR = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
  const pw = hashPassword(DEMO_PASSWORD);
  db.exec('BEGIN');
  try {
    for (const [code, name] of tenants) {
      const t = Number(insT.run(code, name).lastInsertRowid);
      const admin = Number(insR.run(t, 'admin', '회사 관리자').lastInsertRowid);
      const member = Number(insR.run(t, 'member', '일반 사용자').lastInsertRowid);
      insG.run(admin, 'app', '*'); insG.run(admin, 'widget', '*');
      if (code === 'acme' || code === 'daehan') {
        const a = Number(insU.run(t, 'admin', '관리자', pw, 0, now(), '총무팀', '팀장', `admin@${code}.example`).lastInsertRowid); insUR.run(a, admin);
        const k = Number(insU.run(t, 'kim', '김하늘', pw, 0, now(), '총무팀', '대리', `kim@${code}.example`).lastInsertRowid); insUR.run(k, member);
        const n = Number(insU.run(t, 'newbie', '신입', pw, 1, now(), '총무팀', '사원', null).lastInsertRowid); insUR.run(n, member);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return true;
}

/** Effective permissions = role grants, then per-user exceptions. */
export function effectivePermissions(db, userId) {
  const out = { app: { allow: [], deny: [] }, widget: { allow: [], deny: [] } };
  const roleRows = db.prepare(`SELECT DISTINCT g.kind, g.resource FROM role_grants g
    JOIN user_roles ur ON ur.role_id = g.role_id WHERE ur.user_id = ?`).all(userId);
  for (const r of roleRows) out[r.kind].allow.push(r.resource);
  for (const r of db.prepare('SELECT kind, resource, allow FROM user_grants WHERE user_id = ?').all(userId)) {
    if (r.allow) { if (!out[r.kind].allow.includes(r.resource)) out[r.kind].allow.push(r.resource); }
    else out[r.kind].deny.push(r.resource);
  }
  return out;
}

export function can(perms, kind, id) {
  const p = perms[kind];
  return !p.deny.includes(id) && (p.allow.includes('*') || p.allow.includes(id));
}
