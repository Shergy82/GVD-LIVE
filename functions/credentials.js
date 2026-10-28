// Password hashing for GVD LIVE. Credentials live only in the server-side `credentials/{userId}` collection.
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// The browser's old 32-bit hash. Kept ONLY so existing passwords can be verified once and upgraded to scrypt.
function legacyHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => err ? reject(err) : resolve(key));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return { salt: salt.toString('hex'), hash: key.toString('hex'), algo: 'scrypt' };
}

async function verifyPassword(password, cred) {
  if (!cred || !cred.salt || !cred.hash) return false;
  const key = await scrypt(password, Buffer.from(cred.salt, 'hex'));
  const stored = Buffer.from(cred.hash, 'hex');
  return stored.length === key.length && crypto.timingSafeEqual(stored, key);
}

function randomTempPassword() {
  // 10 chars, no look-alikes, easy to read out over the phone
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

module.exports = { legacyHash, hashPassword, verifyPassword, randomTempPassword };
