'use strict';
const assert = require('assert');
const A = require('../auth');
(async () => {
  const hash = await A.hashPassword('CorrectHorseBattery9!');
  assert.match(hash, /^s1\$/);
  assert.strictEqual(await A.verifyPassword('CorrectHorseBattery9!', hash), true);
  assert.strictEqual(await A.verifyPassword('wrong-password', hash), false);
  const secret = 'test-secret-with-enough-entropy';
  const token = A.signToken({ sap: '90000001' }, secret, 60);
  assert.strictEqual(A.verifyToken(token, secret).sap, '90000001');
  assert.strictEqual(A.verifyToken(token + 'x', secret), null);
  assert.strictEqual(A.verifyToken(token, 'different-secret'), null);
  console.log('✓ scrypt password hashing and verification');
  console.log('✓ JWT signature, tamper and secret validation');
})().catch(e => { console.error(e); process.exit(1); });
