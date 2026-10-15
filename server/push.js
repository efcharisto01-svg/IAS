// Web Push (RFC 8030 + VAPID RFC 8292 + message encryption RFC 8291), no external packages.
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

/** VAPID key pair: env IAS_VAPID_PRIVATE (pkcs8 base64url) wins, otherwise stored in the DB and created once. */
export function loadVapid(db, env = process.env) {
  let privB64 = env.IAS_VAPID_PRIVATE;
  if (!privB64) {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'vapid_private'").get();
    if (row) privB64 = row.value;
    else {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      privB64 = b64u(privateKey.export({ type: 'pkcs8', format: 'der' }));
      db.prepare("INSERT INTO server_settings (key, value) VALUES ('vapid_private', ?)").run(privB64);
    }
  }
  const privateKey = crypto.createPrivateKey({ key: unb64u(privB64), format: 'der', type: 'pkcs8' });
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])); // uncompressed point
  return { privateKey, publicKey };
}

export function vapidAuthorization(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** RFC 8291 aes128gcm: returns the request body for one subscription. */
export function encryptPayload(uaPublicB64u, authB64u, plaintext) {
  const uaPublic = unb64u(uaPublicB64u), authSecret = unb64u(authB64u);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const data = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, data]);
}

/**
 * Send one push. Returns { ok, gone, status }. gone=true means the subscription is dead (404/410) and should be deleted.
 * The browser decides how long the notification stays on screen (browser / OS settings).
 */
export async function sendPush(sub, payload, { vapid, subject, fetchImpl = fetch, ttl = 3600 }) {
  const body = encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload));
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(sub.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(ttl), Urgency: 'normal',
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}

export function validSubscription(b) {
  try {
    if (!b || typeof b.endpoint !== 'string' || b.endpoint.length > 1000) return false;
    const u = new URL(b.endpoint);
    if (u.protocol !== 'https:') return false;
    const { p256dh, auth } = b.keys || {};
    return unb64u(String(p256dh)).length === 65 && unb64u(String(auth)).length === 16;
  } catch { return false; }
}
