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
    await d.doc('settings/app').set({ app_name: 'x' });
    await d.doc('settings/invoice_email').set({ x: 1 });
    await d.doc('finance_costs/1').set({ amount: 1 });
    await d.doc('finance_summary/1').set({ cost: 1 });
    await d.doc('customer_invoices/1').set({ n: 1 });
    await d.doc('feedback/1').set({ rating: 5 });
    await d.doc('operative_invoices/i1').set({ user_id: 'op1' });
    await d.doc('operative_invoices/i2').set({ user_id: 'other' });
    await d.doc('notifications/n1').set({ target_user_id: 'op1' });
    await d.doc('notifications/n2').set({ target_user_id: 'admin1' });
    // documents: ordinary files, an Excel file, an invoice (costed to op1), and an old document that was never given a type
    await d.doc('pdfs/doc1').set({ file_type: 'pdf', site_id: '1', filename: 'spec.pdf', uploader_id: 'op1' });
    await d.doc('pdfs/xl1').set({ file_type: 'excel', site_id: '1', filename: 'sheet.xlsx', uploader_id: 'admin1' });
    await d.doc('pdfs/inv1').set({ file_type: 'invoice', site_id: '1', filename: 'inv.pdf', invoice_net: 100, contractor_id: 'op1', po_number: 'PO-1-001' });
    await d.doc('pdfs/inv2').set({ file_type: 'invoice', site_id: '1', filename: 'inv2.pdf', invoice_net: 200, contractor_id: 'other', po_number: 'PO-1-002' });
    await d.doc('pdfs/old1').set({ site_id: '1', filename: 'old.pdf' });
    await d.doc('purchase_orders/PO-1-001').set({ requested_by_id: 'op1', site_id: '1', invoice_value: 100, invoice_no: 'A1' });
    await d.doc('purchase_orders/PO-1-002').set({ requested_by_id: 'other', site_id: '1', invoice_value: 200, invoice_no: 'B2' });
  });
});
after(async () => env && env.cleanup());

const anon = () => env.unauthenticatedContext().firestore();
const admin = () => env.authenticatedContext('admin1', { role: 'Admin', mgmt: true, active: true }).firestore();
const op = () => env.authenticatedContext('op1', { role: 'Operative', mgmt: false, active: true }).firestore();
const ownerCtx = () => env.authenticatedContext('own1', { role: 'Owner', mgmt: true, active: true }).firestore();
const mgrCtx = () => env.authenticatedContext('mgr1', { role: 'Manager', mgmt: true, active: true }).firestore();
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

test('settings: everyone active reads app settings, only management reads invoice_email config', async () => {
  await assertSucceeds(op().doc('settings/app').get());
  await assertFails(op().doc('settings/invoice_email').get());
  await assertSucceeds(admin().doc('settings/invoice_email').get());
  await assertFails(op().doc('settings/app').set({ app_name: 'y' }));
});

test('only an Owner can delete a site; Admins and Managers can still edit and archive', async () => {
  await env.withSecurityRulesDisabled(async ctx => { const d = ctx.firestore(); await d.doc('sites/9').set({ address: 'x' }); await d.doc('sites/10').set({ address: 'y' }); });
  await assertFails(admin().doc('sites/9').delete());
  await assertFails(mgrCtx().doc('sites/9').delete());
  await assertFails(op().doc('sites/9').delete());
  await assertFails(anon().doc('sites/9').delete());
  await assertSucceeds(admin().doc('sites/9').update({ is_archived: true }));
  await assertSucceeds(mgrCtx().doc('sites/10').update({ branch: 'Stoke' }));
  await assertSucceeds(ownerCtx().doc('sites/9').delete());
});

// ---------------------------------------------------------------------------------------------------------------
// Invoices are management business. Ordinary users never read them, however they ask.
// ---------------------------------------------------------------------------------------------------------------
test('invoices: an operative cannot read any invoice record, not even one costed to them', async () => {
  await assertFails(op().doc('pdfs/inv1').get());
  await assertFails(op().doc('pdfs/inv2').get());
  await assertSucceeds(admin().doc('pdfs/inv1').get());
  await assertSucceeds(mgrCtx().doc('pdfs/inv2').get());
  await assertSucceeds(ownerCtx().doc('pdfs/inv1').get());
});

test('invoices: asking for the whole documents list is refused for an operative (it could return invoices)', async () => {
  await assertFails(op().collection('pdfs').get());
  await assertFails(op().collection('pdfs').where('site_id', '==', '1').get());
  await assertFails(op().collection('pdfs').where('file_type', '==', 'invoice').get());
  await assertFails(op().collection('pdfs').where('contractor_id', '==', 'op1').get());
  await assertFails(op().collection('pdfs').where('po_number', '==', 'PO-1-001').get());
  await assertSucceeds(admin().collection('pdfs').get());
});

test("invoices: the app's own request for an operative (file_type != 'invoice') works and returns documents only", async () => {
  const snap = await assertSucceeds(op().collection('pdfs').where('file_type', '!=', 'invoice').get());
  assert.deepStrictEqual(snap.docs.map(d => d.id).sort(), ['doc1', 'xl1']);
  const typed = await assertSucceeds(op().collection('pdfs').where('file_type', 'in', ['pdf', 'excel']).get());
  assert.deepStrictEqual(typed.docs.map(d => d.id).sort(), ['doc1', 'xl1']);
  const all = await assertSucceeds(admin().collection('pdfs').get());
  assert.strictEqual(all.size, 5);
});

test('invoices: a document that was never typed is closed to operatives until management types it', async () => {
  await assertFails(op().doc('pdfs/old1').get());
  await assertSucceeds(admin().doc('pdfs/old1').get());
  await assertSucceeds(admin().doc('pdfs/old1').update({ file_type: 'pdf' }));          // what tagUntypedDocuments does
  await assertSucceeds(op().doc('pdfs/old1').get());
  await env.withSecurityRulesDisabled(async ctx => { await ctx.firestore().doc('pdfs/old1').set({ site_id: '1', filename: 'old.pdf' }); });   // back to untyped for the next test
});

test('invoices: ordinary documents still work for operatives (read, upload, change, delete) but they cannot make or touch invoices', async () => {
  await assertSucceeds(op().doc('pdfs/doc1').get());
  await assertSucceeds(op().doc('pdfs/new1').set({ file_type: 'pdf', site_id: '1', filename: 'a.pdf', uploader_id: 'op1' }));
  await assertSucceeds(op().doc('pdfs/new2').set({ file_type: 'excel', site_id: '1', filename: 'a.xlsx', uploader_id: 'op1' }));
  await assertSucceeds(op().doc('pdfs/new1').update({ filename: 'b.pdf' }));
  await assertSucceeds(op().doc('pdfs/new1').delete());
  // cannot create an invoice, or an untyped document (which nobody but management could then read)
  await assertFails(op().doc('pdfs/bad1').set({ file_type: 'invoice', site_id: '1', invoice_net: 1 }));
  await assertFails(op().doc('pdfs/bad2').set({ site_id: '1', filename: 'x.pdf' }));
  await assertFails(op().doc('pdfs/bad3').set({ file_type: 'something-else', site_id: '1' }));
  // cannot turn a document into an invoice, or change/delete an invoice
  await assertFails(op().doc('pdfs/new2').update({ file_type: 'invoice' }));
  await assertFails(op().doc('pdfs/inv1').update({ invoice_net: 1 }));
  await assertFails(op().doc('pdfs/inv1').update({ file_type: 'pdf' }));
  await assertFails(op().doc('pdfs/inv1').delete());
  await assertSucceeds(op().doc('pdfs/new2').delete());
});

test('invoices: management can create, change and delete invoices', async () => {
  await assertSucceeds(mgrCtx().doc('pdfs/inv9').set({ file_type: 'invoice', site_id: '1', invoice_net: 5 }));
  await assertSucceeds(admin().doc('pdfs/inv9').update({ invoice_net: 6 }));
  await assertSucceeds(ownerCtx().doc('pdfs/inv9').delete());
});

test('invoices: signed-out and pending users read nothing from documents', async () => {
  await assertFails(anon().doc('pdfs/doc1').get());
  await assertFails(anon().collection('pdfs').where('file_type', '!=', 'invoice').get());
  await assertFails(pend().doc('pdfs/doc1').get());
  await assertFails(pend().collection('pdfs').where('file_type', '!=', 'invoice').get());
  await assertFails(pend().doc('pdfs/new9').set({ file_type: 'pdf', site_id: '1' }));
});

test('purchase orders carry invoice figures: an operative reads only their own, management read all', async () => {
  await assertSucceeds(op().doc('purchase_orders/PO-1-001').get());
  await assertFails(op().doc('purchase_orders/PO-1-002').get());
  await assertFails(op().collection('purchase_orders').get());
  const mine = await assertSucceeds(op().collection('purchase_orders').where('requested_by_id', '==', 'op1').get());
  assert.deepStrictEqual(mine.docs.map(d => d.id), ['PO-1-001']);
  await assertFails(op().collection('purchase_orders').where('requested_by_id', '==', 'other').get());
  const everything = await assertSucceeds(admin().collection('purchase_orders').get());
  assert.strictEqual(everything.size, 2);
});

test('purchase orders: an operative can request their own, not for someone else, and cannot edit or delete', async () => {
  await assertSucceeds(op().doc('purchase_orders/PO-1-050').set({ requested_by_id: 'op1', site_id: '1', merchant: 'M', status: 'Requested' }));
  await assertFails(op().doc('purchase_orders/PO-1-051').set({ requested_by_id: 'other', site_id: '1', merchant: 'M' }));
  await assertFails(op().doc('purchase_orders/PO-1-050').update({ invoice_value: 999, status: 'Invoiced' }));
  await assertFails(op().doc('purchase_orders/PO-1-050').delete());
  await assertFails(op().doc('purchase_orders/PO-1-001').update({ invoice_value: 1 }));
  await assertSucceeds(admin().doc('purchase_orders/PO-1-050').update({ status: 'Collected' }));
  await assertSucceeds(mgrCtx().doc('purchase_orders/PO-1-050').delete());
  await assertFails(anon().doc('purchase_orders/PO-1-001').get());
  await assertFails(pend().doc('purchase_orders/PO-1-001').get());
});
