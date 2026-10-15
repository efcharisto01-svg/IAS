import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { DEMO_PASSWORD } from '../server/db.js';
import { encryptPayload, vapidAuthorization, loadVapid } from '../server/push.js';
import { openDb } from '../server/db.js';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

/** A browser's side of RFC 8291, written separately from the server code. */
function makeDevice() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const keys = { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) };
  function decrypt(body) {
    const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    assert.equal(rs, 4096); assert.equal(idlen, 65);
    const secret = ecdh.computeSecret(asPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, keyInfo, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
    return plain.subarray(0, plain.length - 1).toString();
  }
  return { keys, decrypt };
}

test('payload encryption round-trips and is not plaintext', () => {
  const dev = makeDevice();
  const body = encryptPayload(dev.keys.p256dh, dev.keys.auth, '안녕하세요 새 공지');
  assert.equal(dev.decrypt(body), '안녕하세요 새 공지');
  assert.ok(!body.toString('latin1').includes('공지'));
  assert.notDeepEqual(encryptPayload(dev.keys.p256dh, dev.keys.auth, 'x'), encryptPayload(dev.keys.p256dh, dev.keys.auth, 'x'), 'fresh keys and salt every time');
  assert.throws(() => encryptPayload('AAAA', dev.keys.auth, 'x'), /bad subscription keys/);
});

test('VAPID header carries a valid ES256 signature for the push service origin', () => {
  const db = openDb(':memory:'); const vapid = loadVapid(db, {});
  assert.equal(unb64u(vapid.publicKey).length, 65);
  assert.equal(loadVapid(db, {}).publicKey, vapid.publicKey, 'key is created once and kept');
  const h = vapidAuthorization('https://push.example.com/send/abc', vapid, 'mailto:a@b.c');
  const [, t, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  const [head, claims, sig] = t.split('.');
  assert.deepEqual(JSON.parse(unb64u(head)), { typ: 'JWT', alg: 'ES256' });
  const c = JSON.parse(unb64u(claims)); assert.equal(c.aud, 'https://push.example.com'); assert.ok(c.exp > Date.now() / 1000);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(unb64u(k).subarray(1, 33)), y: b64u(unb64u(k).subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, unb64u(sig)));
});

let app, base, calls, status;
before(async () => {
  calls = []; status = 201;
  app = createApp({ dbFile: ':memory:', pushFetch: async (url, init) => { calls.push({ url, init }); return { status }; } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const call = (path, { method = 'GET', cookie, body } = {}) => fetch(base + path, {
  method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
});
async function login(userId) {
  const r = await call('/api/auth/login', { method: 'POST', body: { company: 'acme', userId, password: DEMO_PASSWORD } });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const person = (l) => app.db.prepare("SELECT id, tenant_id FROM users WHERE login_id = ? AND tenant_id = (SELECT id FROM tenants WHERE code='acme')").get(l);
const sub = (dev, n = 1) => ({ endpoint: `https://push.example.com/send/device-${n}`, keys: dev.keys });

test('push endpoints need a session and a valid subscription', async () => {
  assert.equal((await call('/api/push/key')).status, 401);
  assert.equal((await call('/api/push/subscribe', { method: 'POST', body: {} })).status, 401);
  const c = await login('kim');
  const key = await (await call('/api/push/key', { cookie: c })).json();
  assert.equal(unb64u(key.publicKey).length, 65);
  const dev = makeDevice();
  for (const bad of [{}, { endpoint: 'http://insecure.example/x', keys: dev.keys }, { endpoint: 'https://x.example/y', keys: { p256dh: 'AAAA', auth: 'AAAA' } }])
    assert.equal((await call('/api/push/subscribe', { method: 'POST', cookie: c, body: bad })).status, 400);
  assert.equal((await call('/api/push/subscribe', { method: 'POST', cookie: c, body: sub(dev) })).status, 200);
});

test('a notification is pushed (encrypted) to the user devices, with the right content', async () => {
  const kim = person('kim'); calls.length = 0;
  const dev = makeDevice(); const c = await login('kim');
  await call('/api/push/subscribe', { method: 'POST', cookie: c, body: sub(dev, 2) });
  app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: '시스템', title: '푸시 시험', body: '본문', link: 'home.html' });
  await app.flushPush();
  const mine = calls.filter((x) => x.url.endsWith('device-2'));
  assert.equal(mine.length, 1);
  const { init } = mine[0];
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm'); assert.match(init.headers.Authorization, /^vapid t=.+, k=.+$/);
  const msg = JSON.parse(dev.decrypt(Buffer.from(init.body)));
  assert.equal(msg.title, '푸시 시험'); assert.equal(msg.source, '시스템'); assert.equal(msg.link, 'home.html'); assert.ok(msg.id > 0);
});

test('no push for an app the user cannot use; allowed again after a grant', async () => {
  const kim = person('kim'); const dev = makeDevice(); const c = await login('kim');
  await call('/api/push/subscribe', { method: 'POST', cookie: c, body: sub(dev, 3) });
  calls.length = 0;
  app.notify({ tenantId: kim.tenant_id, userId: kim.id, app: 'board', source: '게시판', title: '숨김', link: 'post.html?id=1' });
  await app.flushPush();
  assert.equal(calls.filter((x) => x.url.endsWith('device-3')).length, 0);
  app.db.prepare("INSERT INTO user_grants (user_id, kind, resource, allow) VALUES (?, 'app', 'board', 1)").run(kim.id);
  app.notify({ tenantId: kim.tenant_id, userId: kim.id, app: 'board', source: '게시판', title: '보임', link: 'post.html?id=2' });
  await app.flushPush();
  assert.equal(calls.filter((x) => x.url.endsWith('device-3')).length, 1);
});

test('a dead subscription (410) is deleted; other errors keep it', async () => {
  const kim = person('kim'); const dev = makeDevice(); const c = await login('kim');
  await call('/api/push/subscribe', { method: 'POST', cookie: c, body: sub(dev, 4) });
  const has = () => app.db.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%device-4'").get().n;
  status = 500; app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: '시스템', title: 'a' }); await app.flushPush();
  assert.equal(has(), 1);
  status = 410; app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: '시스템', title: 'b' }); await app.flushPush();
  assert.equal(has(), 0); status = 201;
});

test('other users get nothing; a device that switches user is re-assigned; unsubscribe only removes your own', async () => {
  const kim = person('kim'), admin = person('admin'); const dev = makeDevice();
  const kc = await login('kim'), ac = await login('admin');
  await call('/api/push/subscribe', { method: 'POST', cookie: kc, body: sub(dev, 5) });
  calls.length = 0;
  app.notify({ tenantId: admin.tenant_id, userId: admin.id, source: '시스템', title: '관리자에게만' }); await app.flushPush();
  assert.equal(calls.filter((x) => x.url.endsWith('device-5')).length, 0, "kim's device is not told about admin's notification");
  // the same browser is now used by admin
  await call('/api/push/subscribe', { method: 'POST', cookie: ac, body: sub(dev, 5) });
  calls.length = 0;
  app.notify({ tenantId: kim.tenant_id, userId: kim.id, source: '시스템', title: '김하늘에게만' }); await app.flushPush();
  assert.equal(calls.filter((x) => x.url.endsWith('device-5')).length, 0, 'device moved away from kim');
  assert.equal((await (await call('/api/push/unsubscribe', { method: 'POST', cookie: kc, body: { endpoint: sub(dev, 5).endpoint } })).json()).removed, 0, "kim cannot remove admin's device");
  assert.equal((await (await call('/api/push/unsubscribe', { method: 'POST', cookie: ac, body: { endpoint: sub(dev, 5).endpoint } })).json()).removed, 1);
});

test('sw.js is served, and the notification click only opens safe same-site pages', async () => {
  const r = await fetch(base + '/sw.js');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(await r.text(), /SAFE_LINK/);
});
