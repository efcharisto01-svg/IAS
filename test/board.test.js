import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { DEMO_PASSWORD } from '../server/db.js';

let app, base;
before(async () => {
  app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const api = (path, { method = 'GET', cookie, json, raw, headers = {} } = {}) => fetch(base + path, { method,
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: json !== undefined ? JSON.stringify(json) : raw });
async function login(userId, company = 'acme') {
  const r = await api('/api/auth/login', { method: 'POST', json: { company, userId, password: DEMO_PASSWORD } });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const role = (key, code = 'acme') => app.db.prepare('SELECT r.id FROM roles r JOIN tenants t ON t.id = r.tenant_id WHERE r.key = ? AND t.code = ?').get(key, code).id;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const upload = (cookie, kind, name, buf) => api(`/api/board/upload?kind=${kind}`, { method: 'POST', cookie, raw: buf, headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' } });

let admin, kim, newbie, boardId, catId;
test('setup: the admin creates a board and chooses who may read, write and pin', async () => {
  admin = await login('admin'); kim = await login('kim'); newbie = await login('newbie');
  assert.equal((await api('/api/board/boards', { cookie: kim })).status, 403, 'no 게시판 permission yet');
  assert.equal((await api('/api/board/manage', { cookie: kim })).status, 403);
  const bad = await api('/api/board/manage/boards', { method: 'POST', cookie: admin, json: { name: '', readRoles: [] } });
  assert.equal(bad.status, 400);
  const foreign = role('member', 'daehan');
  assert.equal((await api('/api/board/manage/boards', { method: 'POST', cookie: admin, json: { name: '공지', readRoles: [foreign] } })).status, 400, 'roles of another company are refused');
  const member = role('member');
  const r = await api('/api/board/manage/boards', { method: 'POST', cookie: admin, json: { name: '공지사항', categories: ['인사', '총무'], readRoles: [member], writeRoles: [], pinRoles: [] } });
  assert.equal(r.status, 200); boardId = (await r.json()).id;
  const boards = await (await api('/api/board/boards', { cookie: kim })).json();
  assert.equal(boards.boards.length, 1); assert.equal(boards.boards[0].name, '공지사항');
  assert.deepEqual(boards.boards[0].categories.map((c) => c.name), ['인사', '총무']); catId = boards.boards[0].categories[0].id;
  assert.equal(boards.boards[0].canWrite, false); assert.equal(boards.boards[0].canPin, false); assert.equal(boards.canManage, false);
});

test('writing needs the per-board write permission, checked on the server', async () => {
  const post = { boardId, title: '안녕', body: '본문', categoryId: catId };
  assert.equal((await api('/api/board/posts', { method: 'POST', cookie: kim, json: post })).status, 403);
  const ov = await (await api('/api/board/manage', { cookie: admin })).json();
  const b = ov.boards.find((x) => x.id === boardId);
  assert.deepEqual(b.readRoles, [role('member')]);
  await api('/api/board/manage/boards/' + boardId, { method: 'POST', cookie: admin, json: { writeRoles: [role('member')] } });
  const r = await api('/api/board/posts', { method: 'POST', cookie: kim, json: { ...post, pinned: true, required: true } });
  assert.equal(r.status, 200); const id = (await r.json()).id;
  const d = await (await api('/api/board/posts/' + id, { cookie: kim })).json();
  assert.equal(d.post.pinned, false, 'cannot pin without the pin permission'); assert.equal(d.post.required, false);
  assert.equal(d.flags.canEdit, true); assert.equal(d.flags.canPin, false);
  assert.equal((await api('/api/board/posts', { method: 'POST', cookie: kim, json: { ...post, categoryId: 99999 } })).status, 400);
  assert.equal((await api('/api/board/posts', { method: 'POST', cookie: kim, json: { ...post, title: ' ' } })).status, 400);
  assert.equal((await api('/api/board/posts', { method: 'POST', cookie: kim, json: { ...post, body: '[[img:5]]' } })).status, 400, 'unknown image token');
});

test('pin and 필독: only with the pin permission; a 필독 post notifies the other readers', async () => {
  await api('/api/board/manage/boards/' + boardId, { method: 'POST', cookie: admin, json: { pinRoles: [role('admin')] } });
  const before = app.db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
  const r = await api('/api/board/posts', { method: 'POST', cookie: admin, json: { boardId, title: '필독 안내', body: '꼭 읽어 주세요', pinned: true, required: true } });
  const id = (await r.json()).id;
  const list = await (await api(`/api/board/posts?board=${boardId}`, { cookie: kim })).json();
  assert.equal(list.items[0].id, id, 'pinned first'); assert.equal(list.items[0].required, true); assert.equal(list.items[0].unread, true);
  const n = await (await api('/api/notifications', { cookie: kim })).json();
  assert.ok(JSON.stringify(n).includes('필독')); assert.ok(app.db.prepare('SELECT COUNT(*) n FROM notifications').get().n > before);
  assert.equal(JSON.stringify(await (await api('/api/notifications', { cookie: admin })).json()).includes('필독 글'), false, 'not to the author');
  // reading marks it read and the unread count falls
  const unreadBefore = (await (await api('/api/board/recent', { cookie: kim })).json()).unread;
  await api('/api/board/posts/' + id, { cookie: kim });
  assert.equal((await (await api('/api/board/recent', { cookie: kim })).json()).unread, unreadBefore - 1);
  const after = await (await api(`/api/board/posts?board=${boardId}&q=${encodeURIComponent('필독')}`, { cookie: kim })).json();
  assert.equal(after.items.length, 1); assert.equal(after.items[0].unread, false);
});

test('comments: notify the author, only the writer or a manager can delete', async () => {
  const list = await (await api(`/api/board/posts?board=${boardId}`, { cookie: kim })).json();
  const mine = list.items.find((p) => p.author === '김하늘');
  const c = await api(`/api/board/posts/${mine.id}/comments`, { method: 'POST', cookie: admin, json: { body: '확인했습니다' } });
  assert.equal(c.status, 200); const cid = (await c.json()).id;
  assert.ok(JSON.stringify(await (await api('/api/notifications', { cookie: kim })).json()).includes('댓글'));
  assert.equal((await api(`/api/board/posts/${mine.id}/comments`, { method: 'POST', cookie: admin, json: { body: ' ' } })).status, 400);
  assert.equal((await api('/api/board/comments/' + cid, { method: 'DELETE', cookie: newbie })).status, 403, 'newbie cannot read this board');
  assert.equal((await api('/api/board/comments/' + cid, { method: 'DELETE', cookie: kim })).status, 403, 'not the writer');
  assert.equal((await api('/api/board/comments/' + cid, { method: 'DELETE', cookie: admin })).status, 200);
  const d = await (await api('/api/board/posts/' + mine.id, { cookie: kim })).json();
  assert.equal(d.comments.length, 0);
});

test('files: type, size and magic bytes are checked; images appear inline; downloads need read permission', async () => {
  assert.equal((await upload(kim, 'file', 'a.exe', Buffer.from('x'))).status, 400);
  assert.equal((await upload(kim, 'image', 'a.jpg', Buffer.from('not an image at all, really'))).status, 400);
  assert.equal((await upload(kim, 'file', 'big.pdf', Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await api('/api/board/upload?kind=file', { method: 'POST', cookie: kim, raw: Buffer.from('x') })).status, 400, 'custom header is required');
  const img = await (await upload(kim, 'image', 'p.jpg', JPEG)).json();
  const doc = await (await upload(kim, 'file', '보고서.hwp', Buffer.from('hello'))).json();
  assert.equal((await api('/api/board/files/' + img.id, { cookie: admin })).status, 403, 'unattached: only the uploader');
  const r = await api('/api/board/posts', { method: 'POST', cookie: kim, json: { boardId, title: '첨부', body: `사진 [[img:${img.id}]]`, fileIds: [img.id, doc.id] } });
  assert.equal(r.status, 200); const pid = (await r.json()).id;
  const d = await (await api('/api/board/posts/' + pid, { cookie: admin })).json();
  assert.equal(d.files.length, 2);
  const fi = await api('/api/board/files/' + img.id, { cookie: admin });
  assert.equal(fi.headers.get('content-type'), 'image/jpeg'); assert.match(fi.headers.get('content-disposition'), /^inline/); assert.match(fi.headers.get('content-security-policy'), /sandbox/);
  const fd = await api('/api/board/files/' + doc.id, { cookie: admin });
  assert.match(fd.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/); assert.equal(await fd.text(), 'hello');
  assert.equal((await api('/api/board/files/' + doc.id, { cookie: await login('admin', 'daehan') })).status, 404, 'other company');
  // another user cannot attach someone else's unattached upload
  const other = await (await upload(admin, 'file', 'x.pdf', Buffer.from('x'))).json();
  assert.equal((await api('/api/board/posts', { method: 'POST', cookie: kim, json: { boardId, title: 't', body: 'b', fileIds: [other.id] } })).status, 400);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM board_files WHERE post_id IS NULL').get().n, 1, 'the unused upload is still waiting');
});

test('editing and soft delete: writer or manager only; deleted posts vanish', async () => {
  const id = (await (await api('/api/board/posts', { method: 'POST', cookie: kim, json: { boardId, title: '지울 글', body: 'x' } })).json()).id;
  assert.equal((await api('/api/board/posts/' + id, { method: 'POST', cookie: newbie, json: { title: 'h', body: 'h' } })).status, 403);
  assert.equal((await api('/api/board/posts/' + id, { method: 'POST', cookie: kim, json: { title: '고침', body: 'y', pinned: true } })).status, 200);
  assert.equal((await (await api('/api/board/posts/' + id, { cookie: kim })).json()).post.title, '고침');
  assert.equal((await api('/api/board/posts/' + id, { method: 'DELETE', cookie: newbie })).status, 403);
  assert.equal((await api('/api/board/posts/' + id, { method: 'DELETE', cookie: kim })).status, 200);
  assert.equal((await api('/api/board/posts/' + id, { cookie: kim })).status, 404);
  assert.equal(app.db.prepare('SELECT status FROM posts WHERE id = ?').get(id).status, 'deleted', 'kept in the database');
  const log = app.db.prepare("SELECT before, after, actor_name FROM change_log WHERE table_name = 'posts' AND row_id = ? AND column_name = 'posts.status' ORDER BY id DESC LIMIT 1").get(String(id));
  assert.deepEqual({ ...log }, { before: 'active', after: 'deleted', actor_name: '김하늘' });
});

test('hidden boards, categories and isolation between companies', async () => {
  // someone without read permission sees nothing and cannot post
  assert.equal((await api(`/api/board/posts?board=${boardId}`, { cookie: newbie })).status, 200, 'newbie is a member too');
  await api('/api/board/manage/boards/' + boardId, { method: 'POST', cookie: admin, json: { readRoles: [role('admin')], writeRoles: [role('admin')] } });
  assert.equal((await api(`/api/board/posts?board=${boardId}`, { cookie: kim })).status, 403);
  assert.equal((await api('/api/board/posts', { method: 'POST', cookie: kim, json: { boardId, title: 't', body: 'b' } })).status, 403);
  assert.deepEqual((await (await api('/api/board/boards', { cookie: kim })).json()).boards, []);
  // other company
  const dh = await login('admin', 'daehan');
  assert.deepEqual((await (await api('/api/board/boards', { cookie: dh })).json()).boards, []);
  assert.equal((await api('/api/board/posts', { method: 'POST', cookie: dh, json: { boardId, title: 't', body: 'b' } })).status, 404);
  assert.equal((await api('/api/board/manage/boards/' + boardId, { method: 'POST', cookie: dh, json: { name: 'hack' } })).status, 404);
  // categories
  const add = await (await api(`/api/board/manage/boards/${boardId}/categories`, { method: 'POST', cookie: admin, json: { name: '행사' } })).json();
  assert.equal((await api('/api/board/manage/categories/' + add.id, { method: 'POST', cookie: admin, json: { name: '이벤트' } })).status, 200);
  assert.equal((await api('/api/board/manage/categories/' + add.id, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await api('/api/board/manage/categories/' + add.id, { method: 'DELETE', cookie: dh })).status, 404);
  // hiding
  await api('/api/board/manage/boards/' + boardId, { method: 'POST', cookie: admin, json: { status: 'hidden' } });
  assert.deepEqual((await (await api('/api/board/boards', { cookie: admin })).json()).boards, []);
  assert.equal((await api('/api/board/manage/boards/' + boardId, { method: 'POST', cookie: admin, json: { status: 'weird' } })).status, 400);
});

test('server checks: DELETE and POST need same origin; unauthenticated is 401; widget feed', async () => {
  assert.equal((await api('/api/board/recent')).status, 401);
  assert.equal((await api('/api/board/posts', { method: 'POST', cookie: admin, json: { boardId, title: 't', body: 'b' }, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await api('/api/board/posts/1', { method: 'DELETE', cookie: admin, headers: { Origin: 'http://evil.example' } })).status, 403);
  await api('/api/board/manage/boards/' + boardId, { method: 'POST', cookie: admin, json: { status: 'active' } });
  const rec = await (await api('/api/board/recent', { cookie: admin })).json();
  assert.ok(Array.isArray(rec.items)); assert.equal(typeof rec.unread, 'number');
});
