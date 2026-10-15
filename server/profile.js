import { now } from './db.js';

export const THEMES = ['system', 'light', 'dark'];
export const PHOTO_MAX = 1024 * 1024; // the browser shrinks photos to ~512px before upload

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+\-() ]{5,20}$/;

export function profileOf(db, user, tenant) {
  const photo = db.prepare('SELECT updated_at FROM user_photos WHERE user_id = ?').get(user.id);
  return {
    id: user.id, loginId: user.login_id, name: user.name, tenant: { code: tenant.code, name: tenant.name },
    email: user.email || '', phone: user.phone || '', department: user.department || '', jobTitle: user.job_title || '',
    hasPhoto: !!photo, photoVersion: photo ? photo.updated_at : 0,
  };
}

/** Returns an error code or null. Name, department and job title are managed by the company admin, not here. */
export function updateContact(db, userId, { email, phone }) {
  if (typeof email !== 'string' || typeof phone !== 'string') return 'INVALID_INPUT';
  email = email.trim(); phone = phone.trim();
  if (email && (email.length > 120 || !EMAIL_RE.test(email))) return 'INVALID_EMAIL';
  if (phone && !PHONE_RE.test(phone)) return 'INVALID_PHONE';
  db.prepare('UPDATE users SET email = ?, phone = ? WHERE id = ?').run(email || null, phone || null, userId);
  return null;
}

export function photoMime(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
export const savePhoto = (db, userId, mime, data) =>
  db.prepare(`INSERT INTO user_photos (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`).run(userId, mime, data, now());
export const getPhoto = (db, userId) => db.prepare('SELECT mime, data, updated_at FROM user_photos WHERE user_id = ?').get(userId);
export const deletePhoto = (db, userId) => Number(db.prepare('DELETE FROM user_photos WHERE user_id = ?').run(userId).changes);

export function getSettings(db, userId) {
  const out = { theme: 'system', notifyOff: [] };
  for (const r of db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId)) {
    if (r.key === 'theme' && THEMES.includes(r.value)) out.theme = r.value;
    if (r.key === 'notify_off') { try { out.notifyOff = JSON.parse(r.value).filter((x) => typeof x === 'string'); } catch { /* ignore */ } }
  }
  return out;
}

export function updateSettings(db, userId, b) {
  const put = db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value');
  if (b.theme !== undefined) {
    if (!THEMES.includes(b.theme)) return 'INVALID_THEME';
    put.run(userId, 'theme', b.theme);
  }
  if (b.notifyOff !== undefined) {
    if (!Array.isArray(b.notifyOff) || b.notifyOff.length > 50 || !b.notifyOff.every((x) => typeof x === 'string' && /^[\w.-]{1,40}$/.test(x))) return 'INVALID_INPUT';
    put.run(userId, 'notify_off', JSON.stringify([...new Set(b.notifyOff)]));
  }
  return null;
}

export const isMuted = (db, userId, app) => getSettings(db, userId).notifyOff.includes(app);

export function uaLabel(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? '삼성 인터넷' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '브라우저';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}
