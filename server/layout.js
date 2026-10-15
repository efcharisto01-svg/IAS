import { now } from './db.js';

const ID = /^[\w.-]{1,40}$/;
export const DEFAULT_SPLIT = 0.62;

/** Returns the cleaned layout or null when the input is not acceptable. */
export function cleanLayout(b) {
  if (!b || typeof b !== 'object') return null;
  const ids = (a, max) => Array.isArray(a) && a.length <= max && a.every((x) => typeof x === 'string' && ID.test(x));
  if (!ids(b.widgets, 60) || !ids(b.hidden, 100) || !Array.isArray(b.apps) || b.apps.length > 200) return null;
  const apps = [];
  for (const it of b.apps) {
    if (typeof it === 'string') { if (!ID.test(it)) return null; apps.push(it); continue; }
    if (!it || it.folder !== true || typeof it.id !== 'string' || !/^f[\w-]{1,24}$/.test(it.id) || !ids(it.apps, 50)) return null;
    apps.push({ folder: true, id: it.id, name: String(it.name || '폴더').trim().slice(0, 12) || '폴더', apps: [...new Set(it.apps)] });
  }
  const l = Number(b.split && b.split.l);
  return { widgets: [...new Set(b.widgets)], apps, hidden: [...new Set(b.hidden)], split: { l: Number.isFinite(l) ? Math.min(0.88, Math.max(0.2, l)) : DEFAULT_SPLIT } };
}

export const saveLayout = (db, userId, layout) =>
  db.prepare(`INSERT INTO user_layouts (user_id, layout, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`).run(userId, JSON.stringify(layout), now());
export const resetLayout = (db, userId) => Number(db.prepare('DELETE FROM user_layouts WHERE user_id = ?').run(userId).changes);

/**
 * The layout the home screen shows: the user's saved layout, limited to what the user may use today.
 * New apps appear at the end (unless hidden); a new widget is offered in "위젯 추가" but not added by itself.
 * Without a saved layout everything the user may use is shown.
 */
export function layoutFor(db, userId, catalog) {
  const allowedApps = new Set(catalog.apps.map((a) => a.id)), allowedW = new Set(catalog.widgets.map((w) => w.id));
  const row = db.prepare('SELECT layout FROM user_layouts WHERE user_id = ?').get(userId);
  let saved = null;
  if (row) { try { saved = cleanLayout(JSON.parse(row.layout)); } catch { saved = null; } }
  if (!saved) return { saved: false, widgets: catalog.widgets.map((w) => w.id), apps: catalog.apps.map((a) => a.id), hidden: [], split: { l: DEFAULT_SPLIT } };

  const apps = [], seen = new Set();
  for (const it of saved.apps) {
    if (typeof it === 'string') { if (allowedApps.has(it) && !seen.has(it)) { apps.push(it); seen.add(it); } continue; }
    const inside = it.apps.filter((a) => allowedApps.has(a) && !seen.has(a));
    inside.forEach((a) => seen.add(a));
    if (inside.length >= 2) apps.push({ ...it, apps: inside });
    else if (inside.length === 1) apps.push(inside[0]); // a folder with one app left dissolves
  }
  const hidden = saved.hidden.filter((a) => allowedApps.has(a) && !seen.has(a));
  for (const a of catalog.apps) if (!seen.has(a.id) && !hidden.includes(a.id)) apps.push(a.id);
  return { saved: true, widgets: saved.widgets.filter((w) => allowedW.has(w)), apps, hidden, split: saved.split };
}
