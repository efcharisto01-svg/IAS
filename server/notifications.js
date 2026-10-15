import { now, effectivePermissions, can } from './db.js';

export const RETENTION_DAYS = 60;
const hooks = new Set(); // called after a notification is stored (device push)
export const onNotify = (fn) => { hooks.add(fn); return () => hooks.delete(fn); };
const LINK_RE = /^\/?[\w.-]+\.html(\?[\w=&%.\-]*)?(#[\w-]*)?$/; // same-site page only

/**
 * Create a notification. Every app/widget module calls this.
 *   app    permission resource id of the sender (kind 'app'), or null for system notices.
 *          A user who cannot use that app never sees the notification.
 *   source label shown to the user ('게시판', '시스템' ...)
 *   link   page to open when the notification is clicked (e.g. 'post.html?id=3')
 */
export function notify(db, { tenantId, userId, app = null, source, title, body = '', link = null, at = now() }) {
  if (!source || !title) throw new Error('notify: source and title are required');
  if (link !== null && !LINK_RE.test(link)) throw new Error('notify: link must be a same-site .html page');
  const r = db.prepare(`INSERT INTO notifications (tenant_id, user_id, app, source, title, body, link, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(tenantId, userId, app, String(source).slice(0, 20), String(title).slice(0, 120), String(body).slice(0, 200), link, at);
  const id = Number(r.lastInsertRowid);
  for (const h of hooks) { try { h(db, { id, tenantId, userId, app, source, title, body, link }); } catch (e) { console.error(e); } }
  return id;
}

/** Delete notifications older than RETENTION_DAYS. Returns how many were removed. */
export function purgeOld(db, days = RETENTION_DAYS) {
  return Number(db.prepare('DELETE FROM notifications WHERE created_at < ?').run(now() - days * 86400).changes);
}

/** Visible notifications for a user (permission filtered), newest first, plus counts. */
export function listFor(db, userId, { filter = 'all', limit = 50 } = {}) {
  const perms = effectivePermissions(db, userId);
  const rows = db.prepare(`SELECT id, app, source, title, body, link, created_at, read_at FROM notifications
    WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 500`).all(userId, now() - RETENTION_DAYS * 86400)
    .filter((r) => r.app === null || can(perms, 'app', r.app));
  const unread = rows.filter((r) => r.read_at === null).length;
  const items = rows.filter((r) => filter !== 'unread' || r.read_at === null).slice(0, limit)
    .map((r) => ({ id: r.id, app: r.app, source: r.source, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, read: r.read_at !== null }));
  return { total: rows.length, unread, items };
}

export function markRead(db, userId, id) {
  return Number(db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(now(), id, userId).changes);
}

export function markAllRead(db, userId) {
  // only what the user can see, so hidden notifications are not silently "read"
  const perms = effectivePermissions(db, userId);
  const ids = db.prepare('SELECT id, app FROM notifications WHERE user_id = ? AND read_at IS NULL').all(userId)
    .filter((r) => r.app === null || can(perms, 'app', r.app)).map((r) => r.id);
  const upd = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?');
  const t = now();
  for (const id of ids) upd.run(t, id);
  return ids.length;
}
