/**
 * Column change log (변경 기록): every change of a tracked column is written by the DATABASE itself (triggers),
 * so no code path can forget to log. One row per changed column:
 *
 *   칼럼명(table.column) / 한글명 / 변경전 / 변경후 / 작업일시(초까지) / 변경자
 *   - before is empty when the data did not exist; after is empty when the data was deleted.
 *   - secrets (password hash) are stored as '[숨김]', binary data (photos) as '[이진 데이터 N바이트]'.
 *
 * Who made the change: writes that belong to a signed-in user MUST run inside asUser(db, user, () => { ... }).
 * Writes outside it are logged as "시스템". Seeding / migrations use withoutLog().
 *
 * Adding a table or a column: add it to TRACKED (with a Korean name for EVERY column) or to UNTRACKED (with the reason).
 * The server refuses to start otherwise, and a test checks it, so nothing is silently left out.
 *
 * Protection: rows cannot be UPDATEd, and can only be DELETEd after the retention period (3 years or more).
 */
import { currentContext, retentionDays } from './audit.js';

export const TRACKED = [
  { table: 'tenants', label: '회사', rowId: 'id', tenant: '{r}.id', columns: { id: '회사 번호', code: '회사 코드', name: '회사 이름', status: '상태' } },
  { table: 'users', label: '사용자', rowId: 'id', tenant: '{r}.tenant_id', secret: ['pw_hash'],
    ignore: { failed_count: '로그인 실패 횟수는 잦게 바뀌어 제외(로그인 기록에 남음)', locked_until: '계정 잠금 시각은 로그인 기록에 남음' },
    columns: { id: '사용자 번호', tenant_id: '회사 번호', login_id: '아이디', name: '이름', email: '이메일', pw_hash: '비밀번호', must_change_pw: '비밀번호 변경 필요', status: '상태', created_at: '등록일시', phone: '전화번호', department: '부서', job_title: '직책' } },
  { table: 'roles', label: '역할', rowId: 'id', tenant: '{r}.tenant_id', columns: { id: '역할 번호', tenant_id: '회사 번호', key: '역할 키', name: '역할 이름' } },
  { table: 'user_roles', label: '사용자 역할', rowId: "{r}.user_id || ':' || {r}.role_id", tenant: '(SELECT tenant_id FROM users WHERE id = {r}.user_id)', columns: { user_id: '사용자 번호', role_id: '역할 번호' } },
  { table: 'role_grants', label: '역할 권한', rowId: "{r}.role_id || ':' || {r}.kind || ':' || {r}.resource", tenant: '(SELECT tenant_id FROM roles WHERE id = {r}.role_id)', columns: { role_id: '역할 번호', kind: '권한 종류', resource: '권한 항목' } },
  { table: 'user_grants', label: '사용자별 권한', rowId: "{r}.user_id || ':' || {r}.kind || ':' || {r}.resource", tenant: '(SELECT tenant_id FROM users WHERE id = {r}.user_id)', columns: { user_id: '사용자 번호', kind: '권한 종류', resource: '권한 항목', allow: '허용(1)/차단(0)' } },
  { table: 'user_settings', label: '개인 설정', rowId: "{r}.user_id || ':' || {r}.key", tenant: '(SELECT tenant_id FROM users WHERE id = {r}.user_id)', columns: { user_id: '사용자 번호', key: '설정 이름', value: '설정 값' } },
  { table: 'user_photos', label: '프로필 사진', rowId: 'user_id', tenant: '(SELECT tenant_id FROM users WHERE id = {r}.user_id)', columns: { user_id: '사용자 번호', mime: '사진 형식', data: '사진 파일', updated_at: '사진 변경일시' } },
];

/** Tables that are deliberately not in the column log, and why. */
export const UNTRACKED = {
  sessions: '로그인 세션: 로그인한 기기 목록과 로그인 기록으로 확인',
  push_subscriptions: '기기 알림 구독(키 값): 로그인 기록에 켜기/끄기가 남음',
  notifications: '알림 본문과 읽음 표시: 양이 많고 변경 의미가 없음',
  audit_log: '로그인·보안 기록 자체', change_log: '변경 기록 자체', audit_ctx: '작성자 전달용 내부 표', server_settings: '서버 내부 설정(키)',
};

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ident = (s) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`); return s; };

function valueSql(spec, col, r) {
  const v = `${r}.${ident(col)}`;
  if ((spec.secret || []).includes(col)) return `CASE WHEN ${v} IS NULL THEN NULL ELSE '[숨김]' END`;
  return `CASE WHEN typeof(${v}) = 'blob' THEN '[이진 데이터 ' || length(${v}) || '바이트]' ELSE CAST(${v} AS TEXT) END`;
}

function insertSql(spec, col, label, beforeExpr, afterExpr, r, cond) {
  const tenant = spec.tenant.replace(/\{r\}/g, r), rowId = spec.rowId.includes('{r}') ? spec.rowId.replace(/\{r\}/g, r) : `${r}.${spec.rowId}`;
  return `INSERT INTO change_log (at, tenant_id, table_name, table_label, row_id, column_name, column_label, before, after, user_id, actor, actor_name, req)
    SELECT CAST(strftime('%s', 'now') AS INTEGER), COALESCE(${tenant}, c.tenant_id), ${q(spec.table)}, ${q(spec.label)}, CAST(${rowId} AS TEXT), ${q(`${spec.table}.${col}`)}, ${q(label)},
      ${beforeExpr}, ${afterExpr}, c.user_id, c.actor, c.actor_name, c.req FROM audit_ctx c WHERE c.off = 0 AND ${cond};`;
}

export function installChangeLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS change_log (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, tenant_id INTEGER, table_name TEXT NOT NULL, table_label TEXT NOT NULL, row_id TEXT,
    column_name TEXT NOT NULL, column_label TEXT NOT NULL, before TEXT, after TEXT, user_id INTEGER, actor TEXT, actor_name TEXT, req TEXT
  );
  CREATE INDEX IF NOT EXISTS change_tenant ON change_log(tenant_id, id DESC);
  CREATE TABLE IF NOT EXISTS audit_ctx (id INTEGER PRIMARY KEY CHECK (id = 1), user_id INTEGER, tenant_id INTEGER, actor TEXT, actor_name TEXT, req TEXT, off INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO audit_ctx (id) VALUES (1);`);

  // every table must be decided: tracked or deliberately untracked
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  const known = new Set([...TRACKED.map((t) => t.table), ...Object.keys(UNTRACKED)]);
  const missing = tables.filter((t) => !known.has(t));
  if (missing.length) throw new Error(`changelog: decide for table(s) ${missing.join(', ')}: add to TRACKED (with Korean column names) or UNTRACKED (with a reason)`);

  for (const spec of TRACKED) {
    const cols = db.prepare(`PRAGMA table_info(${ident(spec.table)})`).all().map((c) => c.name);
    const ignore = Object.keys(spec.ignore || {});
    const bad = cols.filter((c) => !(c in spec.columns) && !ignore.includes(c));
    if (bad.length) throw new Error(`changelog: ${spec.table} has no Korean name for column(s) ${bad.join(', ')}`);
    const logged = cols.filter((c) => c in spec.columns);
    const t = ident(spec.table);
    let ins = '', del = '', upd = '';
    for (const col of logged) {
      const label = spec.columns[col];
      ins += insertSql(spec, col, label, 'NULL', valueSql(spec, col, 'NEW'), 'NEW', `NEW.${col} IS NOT NULL`);
      del += insertSql(spec, col, label, valueSql(spec, col, 'OLD'), 'NULL', 'OLD', `OLD.${col} IS NOT NULL`);
      upd += insertSql(spec, col, label, valueSql(spec, col, 'OLD'), valueSql(spec, col, 'NEW'), 'NEW', `OLD.${col} IS NOT NEW.${col}`);
    }
    db.exec(`DROP TRIGGER IF EXISTS chg_${t}_ins; DROP TRIGGER IF EXISTS chg_${t}_upd; DROP TRIGGER IF EXISTS chg_${t}_del;
      CREATE TRIGGER chg_${t}_ins AFTER INSERT ON ${t} BEGIN ${ins} END;
      CREATE TRIGGER chg_${t}_upd AFTER UPDATE ON ${t} BEGIN ${upd} END;
      CREATE TRIGGER chg_${t}_del BEFORE DELETE ON ${t} BEGIN ${del} END;`);
  }

  const days = Math.floor(retentionDays());
  db.exec(`DROP TRIGGER IF EXISTS change_no_update;
    CREATE TRIGGER change_no_update BEFORE UPDATE ON change_log BEGIN SELECT RAISE(ABORT, 'change_log is append-only'); END;
    DROP TRIGGER IF EXISTS change_no_delete;
    CREATE TRIGGER change_no_delete BEFORE DELETE ON change_log
      WHEN OLD.at > CAST(strftime('%s', 'now') AS INTEGER) - ${days} * 86400
      BEGIN SELECT RAISE(ABORT, 'change_log rows are kept for ${days} days'); END;`);
}

const SET = 'UPDATE audit_ctx SET user_id = ?, tenant_id = ?, actor = ?, actor_name = ?, req = ? WHERE id = 1';
const CLEAR = 'UPDATE audit_ctx SET user_id = NULL, tenant_id = NULL, actor = NULL, actor_name = NULL, req = NULL WHERE id = 1';

/** Run synchronous database writes as this user so the change log shows who did it. */
export function asUser(db, user, fn) {
  db.prepare(SET).run(user ? user.id : null, user ? user.tenant_id : null, user ? user.login_id : null, user ? user.name : null, currentContext().reqId ?? null);
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new Error('asUser: fn must be synchronous (do the awaiting before, then write inside)');
    return out;
  } finally { db.exec(CLEAR); }
}

/** Seeding, migrations, maintenance: nothing is written to the change log. */
export function withoutLog(db, fn) {
  db.exec('UPDATE audit_ctx SET off = 1 WHERE id = 1');
  try { return fn(); } finally { db.exec('UPDATE audit_ctx SET off = 0 WHERE id = 1'); }
}

const fmtTime = (sec) => { const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

/** Admin query. One company only, newest first. */
export function searchChanges(db, tenantId, { from, to, q: text, table, before, limit = 100 } = {}) {
  const where = ['tenant_id = ?'], args = [tenantId];
  if (from) { where.push('at >= ?'); args.push(Number(from)); }
  if (to) { where.push('at <= ?'); args.push(Number(to)); }
  if (table) { where.push('table_name = ?'); args.push(String(table)); }
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  if (text) {
    const like = `%${String(text).trim().slice(0, 60).replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    where.push("(column_name LIKE ? ESCAPE '\\' OR column_label LIKE ? ESCAPE '\\' OR before LIKE ? ESCAPE '\\' OR after LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR row_id LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like, like, like, like);
  }
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 50000);
  const rows = db.prepare(`SELECT id, at, table_name, table_label, row_id, column_name, column_label, before, after, actor, actor_name FROM change_log
    WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, lim + 1);
  return { hasMore: rows.length > lim, items: rows.slice(0, lim).map((r) => ({
    id: r.id, at: r.at, time: fmtTime(r.at), table: r.table_name, tableLabel: r.table_label, rowId: r.row_id, column: r.column_name, label: r.column_label,
    before: r.before ?? '', after: r.after ?? '', actor: r.actor, actorName: r.actor_name || '시스템',
  })) };
}

export const purgeChanges = (db, days = retentionDays()) => Number(db.prepare('DELETE FROM change_log WHERE at < ?').run(Math.floor(Date.now() / 1000) - Math.floor(days) * 86400).changes);

const CSV_COLS = ['칼럼명', '한글명', '변경전', '변경후', '작업일시', '변경자', '대상'];
const cell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
export function changesToCsv(items) {
  const lines = [CSV_COLS.map(cell).join(',')];
  for (const r of items) lines.push([r.column, r.label, r.before, r.after, r.time, r.actorName + (r.actor ? ` (${r.actor})` : ''), `${r.tableLabel} #${r.rowId}`].map(cell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
