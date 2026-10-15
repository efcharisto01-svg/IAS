/** Every app registers itself (and its widgets) here. Add new apps below. */
import { registerApp, registerWidget } from './apps.js';

// 로그기록: company admins only (permission app 'audit', widget 'audit.recent'). Sends no notifications.
registerApp({ id: 'audit', name: '로그기록', color: '#5e5ce6', link: 'log.html', notifies: false,
  icon: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12h6M10 16h6"/>' });
registerWidget({ id: 'audit.recent', name: '최근 변경', size: 'wide', tall: true, script: 'js/widgets/audit-recent.js', app: 'audit' });

// 게시판: permission ids are per board, chosen when the board is created (board.read.<id>, board.write.<id>, board.pin.<id>);
// 'board.manage' manages boards and may remove anyone's posts. Admins (*) get everything.
registerApp({ id: 'board', name: '게시판', color: '#0a84ff', link: 'board.html',
  icon: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>' });
registerWidget({ id: 'board.recent', name: '최근 게시글', size: 'wide', tall: true, script: 'js/widgets/board-recent.js', app: 'board' });
