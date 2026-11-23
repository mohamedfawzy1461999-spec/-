'use strict';
/* أدوات الدخول بدون مكتبات خارجية: تجزئة scrypt وتوكن موقّع HS256 */
const crypto = require('crypto');
const scrypt = (pw, salt, len) => new Promise((ok, no) =>
  crypto.scrypt(pw, salt, len, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? no(e) : ok(k))));
const b64 = s => Buffer.from(s).toString('base64url');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(String(pw), salt, 32);
  return 's1$' + salt.toString('base64') + '$' + h.toString('base64');
}
async function verifyPassword(pw, stored) {
  try {
    const [v, s, h] = String(stored).split('$');
    if (v !== 's1') return false;
    const exp = Buffer.from(h, 'base64');
    return crypto.timingSafeEqual(await scrypt(String(pw), Buffer.from(s, 'base64'), exp.length), exp);
  } catch { return false; }
}
function signToken(payload, secret, ttlSec = 12 * 3600) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return head + '.' + body + '.' + crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
}
function verifyToken(tok, secret) {
  try {
    const [h, b, s] = String(tok).split('.');
    const exp = crypto.createHmac('sha256', secret).update(h + '.' + b).digest();
    const got = Buffer.from(s, 'base64url');
    if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // من غير الحروف المتشابهة (0/O و1/I)
const randomCode = (n = 8) => Array.from({ length: n }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, randomCode };
