/** Every app registers itself (and its widgets) here. Add new apps below. */
import { registerApp, registerWidget } from './apps.js';

// 로그기록: company admins only (permission app 'audit', widget 'audit.recent'). Sends no notifications.
registerApp({ id: 'audit', name: '로그기록', color: '#5e5ce6', link: 'log.html', notifies: false,
  icon: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12h6M10 16h6"/>' });
registerWidget({ id: 'audit.recent', name: '최근 변경', size: 'wide', tall: true, script: 'js/widgets/audit-recent.js', app: 'audit' });
