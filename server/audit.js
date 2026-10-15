/**
 * Audit log (감사 로그): who did what, when, from where. Append-only.
 *
 *   category  'security' (login, password, devices) | 'data' (create/edit/delete of content) | 'admin' (users, roles, grants)
 *   event     short id, e.g. 'login_fail', 'post.created'
 *   Every app/widget that changes data MUST call record() for each create / edit / delete (see CLAUDE.md).
 *
 * Protection (DB level): rows can never be UPDATEd, and a row can only be DELETEd once it is older than the
 * retention period (3 years or more, IAS_AUDIT_RETENTION_DAYS). Nothing in the app can erase a recent entry.
 * Someone with direct write access to the database file could still drop the triggers: keep the file permissions
 * tight and copy the database off the server regularly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { now } from './db.js';

export const MIN_RETENTION_DAYS = 1095; // 3 years
export const CATEGORIES = { security: '로그인·보안', data: '데이터 변경', admin: '관리자 작업' };

export function retentionDays(env = process.env) {
  const n = parseInt(env.IAS_AUDIT_RETENTION_DAYS, 10);
  return Number.isFinite(n) && n > MIN_RETENTION_DAYS ? n : MIN_RETENTION_DAYS;
}

/** Per-request context (ip, user agent, request id) so call sites do not have to pass it around. */
const als = new AsyncLocalStorage();
export const runWithContext = (ctx, fn) => als.run({ reqId: randomBytes(6).toString('hex'), ...ctx }, fn);
export const currentContext = () => als.getStore() || {};

const SECRET_KEY = /pass|token|secret|cookie|authorization|credential|pw_?hash|session/i;
/** Drop secrets from the data attached to a record. Keeps it small and JSON friendly. */
export function sanitize(value, depth = 0) {
  if (value === null || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 300) : value;
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = SECRET_KEY.test(k) ? '[숨김]' : sanitize(v, depth + 1);
  return out;
}

export const maskEmail = (e) => { if (!e) return ''; const [l, d] = String(e).split('@'); return d ? `${l.slice(0, 1)}***@${d}` : '***'; };
export const maskPhone = (p) => { const s = String(p || ''); const d = s.replace(/\D/g, ''); return d.length >= 7 ? `${s.slice(0, 3)}-****-${d.slice(-4)}` : s ? '***' : ''; };

export function installProtection(db, days = retentionDays()) {
  const cols = new Set(db.prepare('PRAGMA table_info(audit_log)').all().map((c) => c.name));
  for (const [c, t] of [['category', 'TEXT'], ['actor', 'TEXT'], ['actor_name', 'TEXT'], ['app', 'TEXT'], ['target_type', 'TEXT'], ['target_id', 'TEXT'], ['summary', 'TEXT'], ['data', 'TEXT'], ['ua', 'TEXT'], ['req', 'TEXT'], ['ok', 'INTEGER NOT NULL DEFAULT 1']])
    if (!cols.has(c)) db.exec(`ALTER TABLE audit_log ADD COLUMN ${c} ${t}`);
  db.exec('CREATE INDEX IF NOT EXISTS audit_tenant_at ON audit_log(tenant_id, id DESC)');
  const d = Math.floor(days);
  db.exec(`DROP TRIGGER IF EXISTS audit_no_update;
    CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    DROP TRIGGER IF EXISTS audit_no_delete;
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
      WHEN OLD.at > CAST(strftime('%s', 'now') AS INTEGER) - ${d} * 86400
      BEGIN SELECT RAISE(ABORT, 'audit_log rows are kept for ${d} days'); END;`);
}

const FIND_USER = (db) => db.prepare('SELECT login_id, name, tenant_id FROM users WHERE id = ?');

/**
 * Append one entry.
 *   record(db, { tenantId, userId, category, event, ok?, app?, target?: { type, id }, summary?, data? })
 * actor (login id and name) is looked up from userId and stored with the entry, so the log stays readable if the account is deleted later.
 */
export function record(db, e) {
  const ctx = currentContext();
  let actor = null, actorName = null, tenantId = e.tenantId ?? null;
  if (e.userId) {
    const u = FIND_USER(db).get(e.userId);
    if (u) { actor = u.login_id; actorName = u.name; if (tenantId === null) tenantId = u.tenant_id; }
  }
  if (!CATEGORIES[e.category]) throw new Error(`audit: unknown category ${e.category}`);
  if (!e.event) throw new Error('audit: event is required');
  const data = e.data === undefined ? null : JSON.stringify(sanitize(e.data));
  const r = db.prepare(`INSERT INTO audit_log (at, tenant_id, user_id, event, ip, detail, category, actor, actor_name, app, target_type, target_id, summary, data, ua, req, ok)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.at ?? now(), tenantId, e.userId ?? null, String(e.event).slice(0, 60), e.ip ?? ctx.ip ?? null, e.category, actor, actorName, e.app ?? null,
    e.target ? String(e.target.type).slice(0, 40) : null, e.target ? String(e.target.id).slice(0, 80) : null,
    e.summary ? String(e.summary).slice(0, 300) : null, data, String(e.ua ?? ctx.ua ?? '').slice(0, 200) || null, ctx.reqId ?? null, e.ok === false ? 0 : 1);
  return Number(r.lastInsertRowid);
}

/** Admin query. Always limited to one company. Newest first. */
export function search(db, tenantId, { from, to, category, q, before, limit = 100 } = {}) {
  const where = ['tenant_id = ?'], args = [tenantId];
  if (from) { where.push('at >= ?'); args.push(Number(from)); }
  if (to) { where.push('at <= ?'); args.push(Number(to)); }
  if (category && CATEGORIES[category]) { where.push('category = ?'); args.push(category); }
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  if (q) {
    const like = `%${String(q).trim().slice(0, 60).replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    where.push("(actor LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR event LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like, like, like);
  }
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 50000);
  const rows = db.prepare(`SELECT id, at, category, event, ok, actor, actor_name, app, target_type, target_id, summary, data, ip, ua, req FROM audit_log
    WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, lim + 1);
  const hasMore = rows.length > lim;
  return { hasMore, items: rows.slice(0, lim).map((r) => ({
    id: r.id, at: r.at, category: r.category || 'security', event: r.event, ok: r.ok === 1, actor: r.actor, actorName: r.actor_name, app: r.app,
    targetType: r.target_type, targetId: r.target_id, summary: r.summary, data: r.data ? JSON.parse(r.data) : null, ip: r.ip, ua: r.ua, req: r.req,
  })) };
}

/** Delete entries older than the retention period. The trigger would refuse anything younger. */
export const purgeExpired = (db, days = retentionDays()) => Number(db.prepare('DELETE FROM audit_log WHERE at < ?').run(now() - Math.floor(days) * 86400).changes);

const CSV_COLS = ['id', '시각', '구분', '이벤트', '결과', '사용자', '이름', '앱', '대상', '내용', 'IP', '기기', '요청ID', '추가정보'];
const cell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }; // blocks spreadsheet formula injection
export function toCsv(items) {
  const lines = [CSV_COLS.map(cell).join(',')];
  for (const r of items) {
    lines.push([r.id, new Date(r.at * 1000).toISOString(), CATEGORIES[r.category] || r.category, r.event, r.ok ? '성공' : '실패', r.actor, r.actorName, r.app,
      r.targetType ? `${r.targetType}:${r.targetId}` : '', r.summary, r.ip, r.ua, r.req, r.data ? JSON.stringify(r.data) : ''].map(cell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel opens Korean text correctly
}
