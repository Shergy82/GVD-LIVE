// Run: node --test functions/fileAccess.test.js   (needs functions/node_modules, no emulator)
// Who may open an invoice file through siteFile: only an active management user, proved by a valid sign-in token.
const test = require('node:test'), assert = require('node:assert');
const { isInvoiceDoc, tokenFromRequest, callerIsManagement } = require('./fileAccess');

// a request the way Express presents it
const req = ({ header, t } = {}) => ({ get: n => (n.toLowerCase() === 'authorization' ? header : undefined), query: t ? { t } : {} });
// a stand-in for Firebase's verifyIdToken: tokens are plain names here, mapped to the claims they would carry
const TOKENS = {
  manager: { mgmt: true, active: true, role: 'Manager' },
  owner: { mgmt: true, active: true, role: 'Owner' },
  operative: { mgmt: false, active: true, role: 'Operative' },
  pending: { mgmt: false, active: false, role: 'Operative' },
  inactiveManager: { mgmt: true, active: false, role: 'Manager' },
  stringTrue: { mgmt: 'true', active: true },
  noClaims: {}
};
const verify = async token => { if (!TOKENS[token]) throw new Error('invalid token'); return TOKENS[token]; };
const allowed = r => callerIsManagement(r, verify);

test('only documents typed invoice are invoices', () => {
  assert.strictEqual(isInvoiceDoc({ file_type: 'invoice' }), true);
  for (const d of [{ file_type: 'pdf' }, { file_type: 'excel' }, {}, null, undefined, { file_type: 'Invoice' }]) assert.strictEqual(isInvoiceDoc(d), false);
});

test('the token is read from the Authorization header, or from ?t= when there is no header', () => {
  assert.strictEqual(tokenFromRequest(req({ header: 'Bearer abc' })), 'abc');
  assert.strictEqual(tokenFromRequest(req({ header: 'bearer   abc ' })), 'abc');
  assert.strictEqual(tokenFromRequest(req({ t: 'xyz' })), 'xyz');
  assert.strictEqual(tokenFromRequest(req({ header: 'Bearer abc', t: 'xyz' })), 'abc');
  assert.strictEqual(tokenFromRequest(req()), '');
  assert.strictEqual(tokenFromRequest({ headers: { authorization: 'Bearer plain' }, query: {} }), 'plain');
});

test('managers and owners are let in, by header or by ?t=', async () => {
  assert.strictEqual(await allowed(req({ header: 'Bearer manager' })), true);
  assert.strictEqual(await allowed(req({ t: 'manager' })), true);
  assert.strictEqual(await allowed(req({ header: 'Bearer owner' })), true);
});

test('nobody else is: operatives, pending or inactive users, odd claims, no token, a bad token', async () => {
  for (const r of [
    req({ header: 'Bearer operative' }), req({ t: 'operative' }), req({ t: 'pending' }), req({ t: 'inactiveManager' }),
    req({ t: 'stringTrue' }), req({ t: 'noClaims' }), req(), req({ header: 'Bearer ' }), req({ t: 'not-a-real-token' }), req({ header: 'Basic manager' })
  ]) assert.strictEqual(await allowed(r), false);
});

test('a token that fails verification (expired, forged, wrong project) is refused even if its name looks right', async () => {
  const failing = async () => { throw new Error('Firebase ID token has expired'); };
  assert.strictEqual(await callerIsManagement(req({ t: 'manager' }), failing), false);
});
