/**
 * App registry: every app registers itself with its permission id (kind 'app') and a display name.
 * Used for "알림 설정 > 앱별 알림" and (later) the home app grid. The first app to register will be 게시판.
 */
import { can } from './db.js';

export const APPS = []; // { id, name }

export function registerApp(app) {
  if (!/^[\w.-]{1,40}$/.test(app.id) || !app.name) throw new Error('registerApp: id and name are required');
  if (!APPS.some((a) => a.id === app.id)) APPS.push({ id: app.id, name: String(app.name).slice(0, 20) });
}

export const appsFor = (perms) => APPS.filter((a) => can(perms, 'app', a.id));
