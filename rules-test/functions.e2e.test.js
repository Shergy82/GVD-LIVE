// End-to-end test of the callable functions against the local emulators (Auth + Firestore + Functions). No production access.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { legacyHash } = require('../functions/credentials');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
initializeApp({ projectId: 'demo-gvd' });
const db = getFirestore();
const FN = 'http://127.0.0.1:5001/demo-gvd/us-central1/';

async function call(name, data, idToken) {
  const r = await fetch(FN + name, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: 'Bearer ' + idToken } : {}) }, body: JSON.stringify({ data }) });
  const j = await r.json();
  return j.error ? { error: j.error } : j.result;
}
async function idTokenFrom(custom) {
  const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
  return (await r.json()).idToken;
}
function claims(idToken) { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()); }

before(async () => {
  await db.doc('users/admin1').set({ full_name: 'Ann Admin', email: 'ann@x.com', role: 'Admin', status: 'Active' });
  await db.doc('credentials/admin1').set({ legacy_hash: legacyHash('oldpass1'), failed_count: 0 });
  await db.doc('users/op1').set({ full_name: 'Ollie Op', email: 'ollie@x.com', role: 'Operative', status: 'Active' });
  await db.doc('credentials/op1').set({ legacy_hash: legacyHash('oppass1'), failed_count: 0 });
  await db.doc('users/rest1').set({ full_name: 'R', email: 'r@x.com', role: 'Operative', status: 'Restricted' });
  await db.doc('credentials/rest1').set({ legacy_hash: legacyHash('rpass12'), failed_count: 0 });
  await db.doc('sites/5').set({ id: 5, address: '1 High St', construction_type: 'Concrete', customer_token: 'tok5' });
  await db.doc('sites/6').set({ id: 6, address: 'Secret', customer_token: 'tok6' });
  await db.doc('shifts/s1').set({ site_id: 5, operative_id: 'op1', shift_date: '2026-11-01', shift_period: 'am', task: 'Screed', secret: 'no' });
  await db.doc('shifts/s2').set({ site_id: 6, operative_id: 'op1', shift_date: '2026-11-01', shift_period: 'am', task: 'Other site' });
  await db.doc('finance_summary/5').set({ cost: 100 });
});

test('legacy login upgrades to scrypt, forces reset, returns claims', async () => {
  const r = await call('login', { email: 'ann@x.com', password: 'oldpass1' });
  assert.ok(r.token);
  assert.strictEqual(r.must_change_password, true);
  assert.ok(!('password_hash' in r.user));
  const c = (await db.doc('credentials/admin1').get()).data();
  assert.strictEqual(c.algo, 'scrypt');
  assert.ok(!c.legacy_hash);
  const idt = await idTokenFrom(r.token);
  const cl = claims(idt);
  assert.strictEqual(cl.mgmt, true); assert.strictEqual(cl.active, true); assert.strictEqual(cl.sub, 'admin1');
  // second login now uses scrypt
  assert.ok((await call('login', { email: 'ann@x.com', password: 'oldpass1' })).token);
});

test('wrong password and unknown email give the same error; restricted refused', async () => {
  const a = await call('login', { email: 'ann@x.com', password: 'nope' });
  const b = await call('login', { email: 'nobody@x.com', password: 'nope' });
  assert.strictEqual(a.error.message, b.error.message);
  const r = await call('login', { email: 'r@x.com', password: 'rpass12' });
  assert.strictEqual(r.error.status, 'PERMISSION_DENIED');
});

test('lockout after repeated failures', async () => {
  for (let i = 0; i < 10; i++) await call('login', { email: 'ollie@x.com', password: 'bad' + i });
  const r = await call('login', { email: 'ollie@x.com', password: 'oppass1' });
  assert.strictEqual(r.error.status, 'RESOURCE_EXHAUSTED');
});

test('setPassword needs auth, then works and clears must_change_password', async () => {
  assert.strictEqual((await call('setPassword', { newPassword: 'brandnew1' })).error.status, 'UNAUTHENTICATED');
  const l = await call('login', { email: 'ann@x.com', password: 'oldpass1' });
  const idt = await idTokenFrom(l.token);
  assert.deepStrictEqual(await call('setPassword', { newPassword: 'brandnew1' }, idt), { ok: true });
  assert.strictEqual((await db.doc('users/admin1').get()).data().must_change_password, false);
  assert.ok((await call('login', { email: 'ann@x.com', password: 'brandnew1' })).token);
  assert.ok((await call('login', { email: 'ann@x.com', password: 'oldpass1' })).error);
});

test('adminSetTempPassword: management only', async () => {
  const l = await call('login', { email: 'ann@x.com', password: 'brandnew1' });
  const adminIdt = await idTokenFrom(l.token);
  const t = await call('adminSetTempPassword', { userId: 'rest1', tempPassword: 'tempo123' }, adminIdt);
  assert.strictEqual(t.tempPassword, 'tempo123');
  assert.strictEqual((await db.doc('users/rest1').get()).data().must_change_password, true);
  assert.ok(!('temp_password' in (await db.doc('users/rest1').get()).data()));
  // an operative cannot
  await db.doc('credentials/op1').set({ failed_count: 0, locked_until: null }, { merge: true });
  const ol = await call('login', { email: 'ollie@x.com', password: 'oppass1' });
  const opIdt = await idTokenFrom(ol.token);
  assert.strictEqual((await call('adminSetTempPassword', { userId: 'rest1', tempPassword: 'hack123' }, opIdt)).error.status, 'PERMISSION_DENIED');
  assert.strictEqual((await call('getFinanceSummary', {}, opIdt)).error.status, 'PERMISSION_DENIED');
  assert.strictEqual((await call('getFinanceSummary', {}, undefined)).error.status, 'UNAUTHENTICATED');
  assert.strictEqual((await call('getFinanceSummary', {}, adminIdt)).jobs.length, 1);
});

test('register: pending user, duplicate refused', async () => {
  const r = await call('register', { full_name: 'New P', email: 'new@x.com', phone: '07', password: 'newpass1', role: 'Admin' });
  assert.strictEqual(r.user.status, 'Pending');
  assert.strictEqual(claims(await idTokenFrom(r.token)).active, false);
  assert.strictEqual((await call('register', { full_name: 'New P', email: 'new@x.com', phone: '07', password: 'newpass1' })).error.status, 'ALREADY_EXISTS');
  assert.ok((await call('login', { email: 'new@x.com', password: 'newpass1' })).token);
});

test('customerView returns only that site and no sensitive fields', async () => {
  const r = await call('customerView', { token: 'tok5' });
  assert.strictEqual(r.site.address, '1 High St');
  assert.strictEqual(r.shifts.length, 1);
  assert.strictEqual(r.shifts[0].operative_name, 'Ollie Op');
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.strictEqual((await call('customerView', { token: 'wrong' })).error.status, 'NOT_FOUND');
});

test('customerFeedback validates, rate-limits, and writes', async () => {
  const ok = { token: 'tok5', rating: 5, customer_name: 'Cat', customer_address: '1 High St', comment: 'Lovely work', consent: true };
  assert.strictEqual((await call('customerFeedback', { ...ok, rating: 9 })).error.status, 'INVALID_ARGUMENT');
  assert.strictEqual((await call('customerFeedback', { ...ok, token: 'bad' })).error.status, 'NOT_FOUND');
  assert.deepStrictEqual(await call('customerFeedback', ok), { ok: true });
  assert.strictEqual((await call('customerFeedback', ok)).error.status, 'RESOURCE_EXHAUSTED');
  assert.strictEqual((await db.collection('feedback').get()).size, 1);
});

test('password reset request is silent for unknown emails and notifies management', async () => {
  assert.deepStrictEqual(await call('requestPasswordReset', { email: 'nobody@x.com' }), { ok: true });
  assert.strictEqual((await db.collection('password_reset_requests').get()).size, 0);
  assert.deepStrictEqual(await call('requestPasswordReset', { email: 'ollie@x.com' }), { ok: true });
  assert.strictEqual((await db.collection('password_reset_requests').get()).size, 1);
});

test('refreshSession gives fresh claims, e.g. after a Pending user is approved', async () => {
  assert.strictEqual((await call('refreshSession', {})).error.status, 'UNAUTHENTICATED');
  const r = await call('login', { email: 'new@x.com', password: 'newpass1' });
  const idt = await idTokenFrom(r.token);
  assert.strictEqual(claims(idt).active, false);
  await db.doc('users/' + r.user.id).update({ status: 'Active' });
  const fresh = await call('refreshSession', {}, idt);
  assert.strictEqual(claims(await idTokenFrom(fresh.token)).active, true);
  await db.doc('users/' + r.user.id).update({ status: 'Restricted' });
  assert.strictEqual((await call('refreshSession', {}, idt)).error.status, 'PERMISSION_DENIED');
});
