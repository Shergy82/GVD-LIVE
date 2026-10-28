const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-gvd',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '../rules-new/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 }
  });
  await env.withSecurityRulesDisabled(async ctx => {
    const d = ctx.firestore();
    await d.doc('users/admin1').set({ full_name: 'A', role: 'Admin', status: 'Active' });
    await d.doc('users/op1').set({ full_name: 'O', role: 'Operative', status: 'Active' });
    await d.doc('users/pend1').set({ full_name: 'P', role: 'Operative', status: 'Pending' });
    await d.doc('credentials/op1').set({ hash: 'x' });
    await d.doc('sites/1').set({ address: 'a', customer_token: 't' });
    await d.doc('shifts/1').set({ site_id: 1 });
    await d.doc('finance_costs/1').set({ amount: 1 });
    await d.doc('finance_summary/1').set({ cost: 1 });
    await d.doc('customer_invoices/1').set({ n: 1 });
    await d.doc('feedback/1').set({ rating: 5 });
    await d.doc('operative_invoices/i1').set({ user_id: 'op1' });
    await d.doc('operative_invoices/i2').set({ user_id: 'other' });
    await d.doc('notifications/n1').set({ target_user_id: 'op1' });
    await d.doc('notifications/n2').set({ target_user_id: 'admin1' });
  });
});
after(async () => env && env.cleanup());

const anon = () => env.unauthenticatedContext().firestore();
const admin = () => env.authenticatedContext('admin1', { role: 'Admin', mgmt: true, active: true }).firestore();
const op = () => env.authenticatedContext('op1', { role: 'Operative', mgmt: false, active: true }).firestore();
const pend = () => env.authenticatedContext('pend1', { role: 'Operative', mgmt: false, active: false }).firestore();

test('anonymous: nothing readable or writable', async () => {
  for (const p of ['users/op1', 'sites/1', 'shifts/1', 'feedback/1', 'finance_summary/1', 'credentials/op1']) {
    await assertFails(anon().doc(p).get());
  }
  await assertFails(anon().doc('users/x').set({ a: 1 }));
  await assertFails(anon().doc('feedback/z').set({ rating: 5 }));
  await assertFails(anon().collection('users').get());
});

test('credentials are never readable or writable by any client', async () => {
  await assertFails(admin().doc('credentials/op1').get());
  await assertFails(op().doc('credentials/op1').set({ hash: 'y' }));
});

test('operative: planner access yes, money no', async () => {
  await assertSucceeds(op().doc('sites/1').get());
  await assertSucceeds(op().doc('shifts/1').update({ seen_at: 'now' }));
  await assertSucceeds(op().doc('users/admin1').get());
  await assertFails(op().doc('sites/1').update({ address: 'b' }));
  for (const c of ['finance_costs', 'finance_summary', 'customer_invoices']) await assertFails(op().doc(c + '/1').get());
  await assertFails(op().doc('finance_costs/2').set({ amount: 5 }));
  await assertFails(op().doc('users/op1').update({ role: 'Owner' }));
  await assertSucceeds(op().doc('users/op1').update({ last_active_at: 'now' }));
});

test('operative: invoices and notifications are own-only', async () => {
  await assertSucceeds(op().doc('operative_invoices/i1').get());
  await assertFails(op().doc('operative_invoices/i2').get());
  await assertFails(op().doc('operative_invoices/i3').set({ user_id: 'other' }));
  await assertSucceeds(op().doc('operative_invoices/i3').set({ user_id: 'op1' }));
  await assertSucceeds(op().doc('notifications/n1').get());
  await assertFails(op().doc('notifications/n2').get());
  await assertSucceeds(op().collection('operative_invoices').where('user_id', '==', 'op1').get());
});

test('management: full access incl. finance, but not credentials', async () => {
  for (const c of ['finance_costs', 'finance_summary', 'customer_invoices', 'operative_invoices/i2']) {
    await assertSucceeds(admin().doc(c.includes('/') ? c : c + '/1').get());
  }
  await assertSucceeds(admin().doc('sites/1').update({ address: 'c' }));
  await assertSucceeds(admin().doc('users/op1').update({ status: 'Restricted' }));
  await assertSucceeds(admin().doc('feedback/1').delete());
  await assertFails(admin().doc('feedback/2').set({ rating: 1 }));
});

test('pending user: can see only own user doc', async () => {
  await assertSucceeds(pend().doc('users/pend1').get());
  await assertFails(pend().doc('users/op1').get());
  await assertFails(pend().doc('sites/1').get());
  await assertFails(pend().doc('shifts/1').get());
});
