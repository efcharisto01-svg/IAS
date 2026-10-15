/**
 * 게시판: several boards, each with categories. Read / write / pin permissions are set per board when the board is created
 * (role grants on the ids board.read.<id>, board.write.<id>, board.pin.<id>); 'board.manage' manages boards and may remove anyone's posts.
 * Posts: text with inline photos ([[img:ID]]), pinned (고정) and 필독, comments, attachments. Deleting hides (soft delete).
 */
import { now, effectivePermissions, can } from './db.js';
import { asUser, withoutLog } from './changelog.js';
import { notify } from './notifications.js';

export const LIMITS = { title: 120, body: 20000, comment: 1000, boardName: 30, categoryName: 20, categories: 30, files: 5, images: 10, fileBytes: 10 * 1024 * 1024, imageBytes: 5 * 1024 * 1024, totalBytes: 30 * 1024 * 1024 };
export const FILE_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx', 'txt', 'csv', 'zip', 'jpg', 'jpeg', 'png', 'gif', 'webp'];

const rid = (kind, id) => `board.${kind}.${id}`;
export const access = (perms, boardId) => ({
  read: can(perms, 'app', rid('read', boardId)), write: can(perms, 'app', rid('write', boardId)), pin: can(perms, 'app', rid('pin', boardId)),
});
export const isManager = (perms) => can(perms, 'app', 'board.manage');
export const hasApp = (perms) => can(perms, 'app', 'board');

export class BoardError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; } }
const bad = (code, extra) => new BoardError(400, code, extra);
const forbid = () => new BoardError(403, 'FORBIDDEN');
const missing = (code = 'NOT_FOUND') => new BoardError(404, code);

const IMG_TOKEN = /\[\[img:(\d+)\]\]/g;
export function imageMime(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return null;
}

const safeName = (n) => String(n || 'file').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'file';
const ext = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');

export function createBoardApi(db) {
  const q = {
    boards: db.prepare("SELECT * FROM boards WHERE tenant_id = ? AND status = 'active' ORDER BY sort_order, id"),
    allBoards: db.prepare('SELECT * FROM boards WHERE tenant_id = ? ORDER BY sort_order, id'),
    board: db.prepare('SELECT * FROM boards WHERE id = ? AND tenant_id = ?'),
    cats: db.prepare('SELECT * FROM board_categories WHERE board_id = ? ORDER BY sort_order, id'),
    cat: db.prepare('SELECT c.* FROM board_categories c JOIN boards b ON b.id = c.board_id WHERE c.id = ? AND b.tenant_id = ?'),
    post: db.prepare("SELECT p.*, u.name AS author_name, b.name AS board_name FROM posts p JOIN users u ON u.id = p.author_id JOIN boards b ON b.id = p.board_id WHERE p.id = ? AND p.tenant_id = ? AND p.status = 'active'"),
    roles: db.prepare('SELECT id, key, name FROM roles WHERE tenant_id = ? ORDER BY id'),
    roleGrantsFor: db.prepare("SELECT role_id FROM role_grants WHERE kind = 'app' AND resource = ?"),
    users: db.prepare("SELECT id FROM users WHERE tenant_id = ? AND status = 'active'"),
  };
  const unreadCount = (userId, boardIds) => (boardIds.length ? db.prepare(`SELECT COUNT(*) AS n FROM posts p WHERE p.status = 'active' AND p.board_id IN (${boardIds.map(() => '?').join(',')})
    AND NOT EXISTS (SELECT 1 FROM post_reads r WHERE r.post_id = p.id AND r.user_id = ?)`).get(...boardIds, userId).n : 0);

  const readable = (user, perms) => q.boards.all(user.tenant_id).filter((b) => access(perms, b.id).read);

  /** Boards this user can read, with categories, what they may do, and unread counts. */
  function listBoards(user, perms) {
    return readable(user, perms).map((b) => {
      const a = access(perms, b.id);
      return { id: b.id, name: b.name, canWrite: a.write, canPin: a.pin, unread: unreadCount(user.id, [b.id]),
        categories: q.cats.all(b.id).map((c) => ({ id: c.id, name: c.name })) };
    });
  }

  function postRow(p, userId, extra = {}) {
    return { id: p.id, boardId: p.board_id, boardName: p.board_name, categoryId: p.category_id, categoryName: p.category_name || '', title: p.title, authorId: p.author_id, author: p.author_name,
      createdAt: p.created_at, comments: p.comments ?? 0, hasFiles: !!p.has_files, pinned: !!p.pinned, required: !!p.required, unread: !p.read_at && p.author_id !== userId, ...extra };
  }
  const LIST_SQL = `SELECT p.id, p.board_id, p.category_id, p.title, p.author_id, p.pinned, p.required, p.created_at, u.name AS author_name, b.name AS board_name, c.name AS category_name,
      (SELECT COUNT(*) FROM comments m WHERE m.post_id = p.id AND m.status = 'active') AS comments,
      EXISTS (SELECT 1 FROM board_files f WHERE f.post_id = p.id AND f.kind = 'file') AS has_files,
      (SELECT read_at FROM post_reads r WHERE r.post_id = p.id AND r.user_id = ?) AS read_at
    FROM posts p JOIN users u ON u.id = p.author_id JOIN boards b ON b.id = p.board_id LEFT JOIN board_categories c ON c.id = p.category_id`;

  function listPosts(user, perms, { boardId, categoryId, q: text, before, limit = 50 } = {}) {
    let ids = readable(user, perms).map((b) => b.id);
    if (boardId) { if (!ids.includes(Number(boardId))) throw forbid(); ids = [Number(boardId)]; }
    if (!ids.length) return { items: [], hasMore: false };
    const where = [`p.status = 'active'`, `p.tenant_id = ?`, `p.board_id IN (${ids.map(() => '?').join(',')})`], args = [user.id, user.tenant_id, ...ids];
    if (categoryId) { where.push('p.category_id = ?'); args.push(Number(categoryId)); }
    if (text) {
      const like = `%${String(text).trim().slice(0, 60).replace(/[%_\\]/g, (m) => '\\' + m)}%`;
      where.push("(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')"); args.push(like, like, like);
    }
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    let pinned = [];
    if (!before) pinned = db.prepare(`${LIST_SQL} WHERE ${where.join(' AND ')} AND p.pinned = 1 ORDER BY p.id DESC LIMIT 30`).all(...args).map((p) => postRow(p, user.id));
    const rest = [...where, 'p.pinned = 0']; const rargs = [...args];
    if (before) { rest.push('p.id < ?'); rargs.push(Number(before)); }
    const rows = db.prepare(`${LIST_SQL} WHERE ${rest.join(' AND ')} ORDER BY p.id DESC LIMIT ?`).all(...rargs, lim + 1);
    return { hasMore: rows.length > lim, items: pinned.concat(rows.slice(0, lim).map((p) => postRow(p, user.id))) };
  }

  const filesOf = (postId) => db.prepare('SELECT id, kind, name, size FROM board_files WHERE post_id = ? ORDER BY id').all(postId).map((f) => ({ id: f.id, kind: f.kind, name: f.name, size: f.size }));

  function getPost(user, perms, id) {
    const p = q.post.get(Number(id), user.tenant_id);
    if (!p) throw missing();
    const a = access(perms, p.board_id);
    if (!a.read) throw forbid();
    const mgr = isManager(perms);
    const first = !db.prepare('SELECT 1 FROM post_reads WHERE user_id = ? AND post_id = ?').get(user.id, p.id);
    if (first) asUser(db, user, () => { db.prepare('INSERT OR IGNORE INTO post_reads (user_id, post_id, read_at) VALUES (?, ?, ?)').run(user.id, p.id, now()); if (user.id !== p.author_id) db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(p.id); });
    const cat = p.category_id ? db.prepare('SELECT name FROM board_categories WHERE id = ?').get(p.category_id) : null;
    const comments = db.prepare(`SELECT m.id, m.body, m.created_at, m.author_id, u.name FROM comments m JOIN users u ON u.id = m.author_id WHERE m.post_id = ? AND m.status = 'active' ORDER BY m.id`).all(p.id)
      .map((m) => ({ id: m.id, body: m.body, createdAt: m.created_at, authorId: m.author_id, author: m.name, canDelete: m.author_id === user.id || mgr }));
    return { post: { id: p.id, boardId: p.board_id, boardName: p.board_name, categoryId: p.category_id, categoryName: cat ? cat.name : '', title: p.title, body: p.body, authorId: p.author_id, author: p.author_name,
        createdAt: p.created_at, updatedAt: p.updated_at, views: p.views + (first && user.id !== p.author_id ? 0 : 0), pinned: !!p.pinned, required: !!p.required },
      files: filesOf(p.id), comments, flags: { canEdit: p.author_id === user.id || mgr, canDelete: p.author_id === user.id || mgr, canPin: a.pin } };
  }

  // ---------------------------------------------------------------- write
  function checkPostInput(b, boardId) {
    const title = typeof b.title === 'string' ? b.title.trim() : '', body = typeof b.body === 'string' ? b.body.replace(/\r\n/g, '\n') : '';
    if (!title || title.length > LIMITS.title) throw bad('INVALID_TITLE');
    if (!body.trim() || body.length > LIMITS.body) throw bad('INVALID_BODY');
    let categoryId = null;
    if (b.categoryId !== null && b.categoryId !== undefined && b.categoryId !== '') {
      const c = db.prepare('SELECT id FROM board_categories WHERE id = ? AND board_id = ?').get(Number(b.categoryId), boardId);
      if (!c) throw bad('INVALID_CATEGORY'); categoryId = c.id;
    }
    const fileIds = Array.isArray(b.fileIds) ? [...new Set(b.fileIds.map(Number))] : [];
    if (fileIds.some((x) => !Number.isInteger(x) || x <= 0) || fileIds.length > LIMITS.files + LIMITS.images) throw bad('INVALID_FILES');
    return { title, body, categoryId, fileIds };
  }

  /** Attach uploaded files to a post and check the numbers; drops files that are no longer wanted. Must run inside a transaction. */
  function syncFiles(user, postId, fileIds, body) {
    const own = fileIds.length ? db.prepare(`SELECT id, kind, size, post_id, uploader_id, tenant_id FROM board_files WHERE id IN (${fileIds.map(() => '?').join(',')})`).all(...fileIds) : [];
    if (own.length !== fileIds.length) throw bad('INVALID_FILES');
    for (const f of own) if (f.tenant_id !== user.tenant_id || (f.post_id !== null && f.post_id !== postId) || (f.post_id === null && f.uploader_id !== user.id)) throw bad('INVALID_FILES');
    const files = own.filter((f) => f.kind === 'file'), images = own.filter((f) => f.kind === 'image');
    if (files.length > LIMITS.files) throw bad('TOO_MANY_FILES'); if (images.length > LIMITS.images) throw bad('TOO_MANY_IMAGES');
    if (own.reduce((s, f) => s + f.size, 0) > LIMITS.totalBytes) throw bad('TOO_BIG_TOTAL');
    const used = [...body.matchAll(IMG_TOKEN)].map((m) => Number(m[1]));
    if (used.some((id) => !images.some((f) => f.id === id))) throw bad('INVALID_IMAGE');
    const keep = new Set(fileIds);
    for (const f of db.prepare('SELECT id FROM board_files WHERE post_id = ?').all(postId)) if (!keep.has(f.id)) db.prepare('DELETE FROM board_files WHERE id = ?').run(f.id);
    for (const f of own) if (f.post_id === null) db.prepare('UPDATE board_files SET post_id = ? WHERE id = ?').run(postId, f.id);
  }

  function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

  function createPost(user, perms, b) {
    const board = q.board.get(Number(b.boardId), user.tenant_id);
    if (!board || board.status !== 'active') throw missing('BOARD_NOT_FOUND');
    const a = access(perms, board.id);
    if (!a.write) throw forbid();
    const { title, body, categoryId, fileIds } = checkPostInput(b, board.id);
    const pinned = b.pinned === true && a.pin ? 1 : 0, required = b.required === true && a.pin ? 1 : 0;
    const id = asUser(db, user, () => tx(() => {
      const t = now();
      const pid = Number(db.prepare(`INSERT INTO posts (tenant_id, board_id, category_id, title, body, author_id, pinned, required, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(user.tenant_id, board.id, categoryId, title, body, user.id, pinned, required, t, t).lastInsertRowid);
      syncFiles(user, pid, fileIds, body);
      db.prepare('INSERT INTO post_reads (user_id, post_id, read_at) VALUES (?, ?, ?)').run(user.id, pid, t);
      return pid;
    }));
    if (required) notifyReaders(user, board, id, title);
    return id;
  }

  function notifyReaders(user, board, postId, title) {
    for (const u of q.users.all(user.tenant_id)) {
      if (u.id === user.id) continue;
      if (!access(effectivePermissions(db, u.id), board.id).read) continue;
      notify(db, { tenantId: user.tenant_id, userId: u.id, app: 'board', source: '게시판', title: '필독 글이 등록되었습니다', body: `${board.name}: ${title}`, link: `post.html?id=${postId}` });
    }
  }

  function updatePost(user, perms, id, b) {
    const p = q.post.get(Number(id), user.tenant_id);
    if (!p) throw missing();
    const a = access(perms, p.board_id);
    if (!a.read) throw forbid();
    if (p.author_id !== user.id && !isManager(perms)) throw forbid();
    const { title, body, categoryId, fileIds } = checkPostInput(b, p.board_id);
    const pinned = a.pin && typeof b.pinned === 'boolean' ? +b.pinned : p.pinned, required = a.pin && typeof b.required === 'boolean' ? +b.required : p.required;
    asUser(db, user, () => tx(() => {
      db.prepare('UPDATE posts SET title = ?, body = ?, category_id = ?, pinned = ?, required = ?, updated_at = ? WHERE id = ?').run(title, body, categoryId, pinned, required, now(), p.id);
      syncFiles(user, p.id, fileIds, body);
    }));
    return p.id;
  }

  function deletePost(user, perms, id) {
    const p = q.post.get(Number(id), user.tenant_id);
    if (!p) throw missing();
    if (!access(perms, p.board_id).read) throw forbid();
    if (p.author_id !== user.id && !isManager(perms)) throw forbid();
    asUser(db, user, () => db.prepare("UPDATE posts SET status = 'deleted', updated_at = ? WHERE id = ?").run(now(), p.id));
  }

  function addComment(user, perms, postId, b) {
    const p = q.post.get(Number(postId), user.tenant_id);
    if (!p) throw missing();
    if (!access(perms, p.board_id).read) throw forbid();
    const body = typeof b.body === 'string' ? b.body.trim() : '';
    if (!body || body.length > LIMITS.comment) throw bad('INVALID_COMMENT');
    const id = asUser(db, user, () => Number(db.prepare('INSERT INTO comments (tenant_id, post_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(user.tenant_id, p.id, user.id, body, now()).lastInsertRowid));
    if (p.author_id !== user.id) notify(db, { tenantId: user.tenant_id, userId: p.author_id, app: 'board', source: '게시판', title: '내 글에 댓글이 달렸습니다', body: `${user.name}: ${body.slice(0, 60)}`, link: `post.html?id=${p.id}` });
    return id;
  }

  function deleteComment(user, perms, id) {
    const c = db.prepare("SELECT m.*, p.board_id FROM comments m JOIN posts p ON p.id = m.post_id WHERE m.id = ? AND m.tenant_id = ? AND m.status = 'active'").get(Number(id), user.tenant_id);
    if (!c) throw missing();
    if (!access(perms, c.board_id).read) throw forbid();
    if (c.author_id !== user.id && !isManager(perms)) throw forbid();
    asUser(db, user, () => db.prepare("UPDATE comments SET status = 'deleted' WHERE id = ?").run(c.id));
  }

  // ---------------------------------------------------------------- files
  function saveUpload(user, perms, { kind, name, buf }) {
    if (!hasApp(perms)) throw forbid();
    name = safeName(name);
    if (kind === 'image') {
      const mime = imageMime(buf);
      if (!mime) throw bad('INVALID_IMAGE'); if (buf.length > LIMITS.imageBytes) throw new BoardError(413, 'TOO_LARGE');
      return store(user, 'image', name, mime, buf);
    }
    if (!FILE_EXT.includes(ext(name))) throw bad('FILE_TYPE_NOT_ALLOWED');
    if (!buf.length) throw bad('EMPTY_FILE'); if (buf.length > LIMITS.fileBytes) throw new BoardError(413, 'TOO_LARGE');
    return store(user, 'file', name, 'application/octet-stream', buf);
  }
  function store(user, kind, name, mime, buf) {
    const id = asUser(db, user, () => Number(db.prepare('INSERT INTO board_files (tenant_id, uploader_id, post_id, kind, name, mime, size, data, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)').run(user.tenant_id, user.id, kind, name, mime, buf.length, buf, now()).lastInsertRowid));
    return { id, kind, name, size: buf.length };
  }
  function getFile(user, perms, id) {
    const f = db.prepare('SELECT * FROM board_files WHERE id = ? AND tenant_id = ?').get(Number(id), user.tenant_id);
    if (!f) throw missing();
    if (f.post_id === null) { if (f.uploader_id !== user.id) throw forbid(); }
    else {
      const p = db.prepare("SELECT board_id FROM posts WHERE id = ? AND status = 'active'").get(f.post_id);
      if (!p) throw missing(); if (!access(perms, p.board_id).read) throw forbid();
    }
    return { kind: f.kind, name: f.name, mime: f.mime, data: Buffer.from(f.data) };
  }
  /** Files uploaded but never attached to a post (older than a day) are removed. */
  const purgeOrphans = () => withoutLog(db, () => Number(db.prepare('DELETE FROM board_files WHERE post_id IS NULL AND created_at < ?').run(now() - 86400).changes));

  // ---------------------------------------------------------------- widget
  function recent(user, perms, limit = 6) {
    const ids = readable(user, perms).map((b) => b.id);
    if (!ids.length) return { unread: 0, items: [] };
    const rows = db.prepare(`${LIST_SQL} WHERE p.status = 'active' AND p.tenant_id = ? AND p.board_id IN (${ids.map(() => '?').join(',')}) ORDER BY p.pinned DESC, p.id DESC LIMIT ?`).all(user.id, user.tenant_id, ...ids, Math.min(limit, 20));
    return { unread: unreadCount(user.id, ids), items: rows.map((p) => postRow(p, user.id)) };
  }

  // ---------------------------------------------------------------- manage
  const roleIdsOf = (resource) => q.roleGrantsFor.all(resource).map((r) => r.role_id);
  function manageOverview(user) {
    const roles = q.roles.all(user.tenant_id).map((r) => ({ id: r.id, key: r.key, name: r.name }));
    const inTenant = new Set(roles.map((r) => r.id));
    const boards = q.allBoards.all(user.tenant_id).map((b) => ({ id: b.id, name: b.name, status: b.status, sortOrder: b.sort_order,
      categories: q.cats.all(b.id).map((c) => ({ id: c.id, name: c.name })),
      readRoles: roleIdsOf(rid('read', b.id)).filter((x) => inTenant.has(x)), writeRoles: roleIdsOf(rid('write', b.id)).filter((x) => inTenant.has(x)), pinRoles: roleIdsOf(rid('pin', b.id)).filter((x) => inTenant.has(x)) }));
    return { roles, boards };
  }
  function setRoles(user, boardId, kind, roleIds) {
    if (!Array.isArray(roleIds)) throw bad('INVALID_ROLES');
    const valid = new Set(q.roles.all(user.tenant_id).map((r) => r.id));
    const want = [...new Set(roleIds.map(Number))];
    if (want.some((x) => !valid.has(x))) throw bad('INVALID_ROLES');
    const resource = rid(kind, boardId);
    db.prepare(`DELETE FROM role_grants WHERE kind = 'app' AND resource = ? AND role_id IN (SELECT id FROM roles WHERE tenant_id = ?)`).run(resource, user.tenant_id);
    for (const r of want) {
      db.prepare("INSERT OR IGNORE INTO role_grants (role_id, kind, resource) VALUES (?, 'app', ?)").run(r, resource);
      db.prepare("INSERT OR IGNORE INTO role_grants (role_id, kind, resource) VALUES (?, 'app', 'board')").run(r); // the roles that use a board also get the 게시판 app and its widget
      db.prepare("INSERT OR IGNORE INTO role_grants (role_id, kind, resource) VALUES (?, 'widget', 'board.recent')").run(r);
    }
  }
  function cleanName(n, max, code) { const s = typeof n === 'string' ? n.trim() : ''; if (!s || s.length > max) throw bad(code); return s; }

  function createBoard(user, b) {
    const name = cleanName(b.name, LIMITS.boardName, 'INVALID_NAME');
    const cats = (Array.isArray(b.categories) ? b.categories : []).map((c) => cleanName(c, LIMITS.categoryName, 'INVALID_CATEGORY'));
    if (cats.length > LIMITS.categories) throw bad('TOO_MANY_CATEGORIES');
    return asUser(db, user, () => tx(() => {
      const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM boards WHERE tenant_id = ?').get(user.tenant_id).n;
      const id = Number(db.prepare('INSERT INTO boards (tenant_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)').run(user.tenant_id, name, next, now()).lastInsertRowid);
      cats.forEach((c, i) => db.prepare('INSERT INTO board_categories (board_id, name, sort_order) VALUES (?, ?, ?)').run(id, c, i + 1));
      setRoles(user, id, 'read', b.readRoles ?? []); setRoles(user, id, 'write', b.writeRoles ?? []); setRoles(user, id, 'pin', b.pinRoles ?? []);
      return id;
    }));
  }
  function updateBoard(user, id, b) {
    const board = q.board.get(Number(id), user.tenant_id);
    if (!board) throw missing();
    asUser(db, user, () => tx(() => {
      if (b.name !== undefined) db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(cleanName(b.name, LIMITS.boardName, 'INVALID_NAME'), board.id);
      if (b.status !== undefined) { if (!['active', 'hidden'].includes(b.status)) throw bad('INVALID_STATUS'); db.prepare('UPDATE boards SET status = ? WHERE id = ?').run(b.status, board.id); }
      if (b.readRoles !== undefined) setRoles(user, board.id, 'read', b.readRoles);
      if (b.writeRoles !== undefined) setRoles(user, board.id, 'write', b.writeRoles);
      if (b.pinRoles !== undefined) setRoles(user, board.id, 'pin', b.pinRoles);
    }));
  }
  function addCategory(user, boardId, b) {
    const board = q.board.get(Number(boardId), user.tenant_id);
    if (!board) throw missing();
    const name = cleanName(b.name, LIMITS.categoryName, 'INVALID_CATEGORY');
    if (q.cats.all(board.id).length >= LIMITS.categories) throw bad('TOO_MANY_CATEGORIES');
    return asUser(db, user, () => Number(db.prepare('INSERT INTO board_categories (board_id, name, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM board_categories WHERE board_id = ?))').run(board.id, name, board.id).lastInsertRowid));
  }
  function renameCategory(user, id, b) {
    const c = q.cat.get(Number(id), user.tenant_id);
    if (!c) throw missing();
    const name = cleanName(b.name, LIMITS.categoryName, 'INVALID_CATEGORY');
    asUser(db, user, () => db.prepare('UPDATE board_categories SET name = ? WHERE id = ?').run(name, c.id));
  }
  function deleteCategory(user, id) {
    const c = q.cat.get(Number(id), user.tenant_id);
    if (!c) throw missing();
    asUser(db, user, () => tx(() => { db.prepare('UPDATE posts SET category_id = NULL WHERE category_id = ?').run(c.id); db.prepare('DELETE FROM board_categories WHERE id = ?').run(c.id); }));
  }

  return { listBoards, listPosts, getPost, createPost, updatePost, deletePost, addComment, deleteComment, saveUpload, getFile, purgeOrphans, recent,
    manageOverview, createBoard, updateBoard, addCategory, renameCategory, deleteCategory };
}
