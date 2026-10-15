/**
 * App and widget registry. An app and its widget(s) are built together and registered here with their permission ids.
 *   registerApp({ id, name, color, link, icon?, notifies? })      permission: kind 'app', resource id
 *   registerWidget({ id, name, size, tall?, script, app? })       permission: kind 'widget', resource id
 *     size: 'small' (half width) | 'wide' (full width on phones, 2/3 on tablets) | 'full'; tall: two rows high
 *     script: the browser file that draws the widget (calls IAS.widgets.define(id, ...))
 * The home screen shows exactly what the signed-in user may use (role grants + per-user exceptions).
 * Apps that never send notifications set notifies:false so they do not appear in 알림 설정.
 */
import { can } from './db.js';

export const APPS = [];     // { id, name, color, link, icon?, notifies }
export const WIDGETS = [];  // { id, name, size, tall, script, app }

export function registerApp(a) {
  if (!/^[\w.-]{1,40}$/.test(a.id) || !a.name) throw new Error('registerApp: id and name are required');
  if (a.link && !/^[\w.-]+\.html$/.test(a.link)) throw new Error('registerApp: link must be a same-site .html page');
  if (!APPS.some((x) => x.id === a.id)) APPS.push({ id: a.id, name: String(a.name).slice(0, 20), color: a.color || '#0a84ff', link: a.link || null, icon: a.icon || null, notifies: a.notifies !== false });
}

export function registerWidget(w) {
  if (!/^[\w.-]{1,40}$/.test(w.id) || !w.name || !/^js\/[\w./-]+\.js$/.test(w.script || '')) throw new Error('registerWidget: id, name and a js/ script are required');
  if (!['small', 'wide', 'full'].includes(w.size)) throw new Error('registerWidget: size must be small, wide or full');
  if (!WIDGETS.some((x) => x.id === w.id)) WIDGETS.push({ id: w.id, name: String(w.name).slice(0, 20), size: w.size, tall: !!w.tall, script: w.script, app: w.app || null });
}

/** Apps listed in 알림 설정 (the ones that can send notifications). */
export const appsFor = (perms) => APPS.filter((a) => a.notifies && can(perms, 'app', a.id)).map((a) => ({ id: a.id, name: a.name }));
/** Everything this user may put on the home screen. */
export const catalogFor = (perms) => ({
  apps: APPS.filter((a) => can(perms, 'app', a.id)).map(({ id, name, color, link, icon }) => ({ id, name, color, link, icon })),
  widgets: WIDGETS.filter((w) => can(perms, 'widget', w.id)).map(({ id, name, size, tall, script, app }) => ({ id, name, size, tall, script, app })),
});
