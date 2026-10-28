// Seeds the LOCAL emulator only (refuses anything else). Test accounts: pass = <name>pw1
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { legacyHash } = require('../functions/credentials');
initializeApp({ projectId: 'demo-gvd' });
const db = getFirestore();
(async () => {
  const U = [
    ['own1', 'Olive Owner', 'owner@test.com', 'Owner', 'Active', 'ownerpw1'],
    ['adm1', 'Adam Admin', 'admin@test.com', 'Admin', 'Active', 'adminpw1'],
    ['man1', 'Mia Manager', 'manager@test.com', 'Manager', 'Active', 'managerpw1'],
    ['op1', 'Ollie Operative', 'op@test.com', 'Operative', 'Active', 'oppw1x'],
    ['pen1', 'Pat Pending', 'pending@test.com', 'Operative', 'Pending', 'pendingpw1']
  ];
  for (const [id, full_name, email, role, status, pw] of U) {
    await db.doc('users/' + id).set({ id, full_name, email, role, status, phone: '07000' });
    await db.doc('credentials/' + id).set({ legacy_hash: legacyHash(pw), failed_count: 0 });
  }
  await db.doc('sites/1').set({ id: 1, address: '1 Test Street', construction_type: 'Concrete', customer_token: 'tok_test' });
  await db.doc('shifts/1').set({ id: 1, site_id: 1, operative_id: 'op1', shift_date: '2099-01-02', shift_period: 'am', task: 'Pour slab' });
  await db.doc('shifts/2').set({ id: 2, site_id: 1, operative_id: 'op1', shift_date: '2020-01-02', shift_period: 'pm', task: 'Old task' });
  await db.doc('finance_jobs/1').set({ value: 1000 });
  await db.doc('settings/app').set({ app_name: 'GVD LIVE', logo_url: '/gvd-logo.png' });
  console.log('seeded');
})();
