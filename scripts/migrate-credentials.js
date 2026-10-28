// Moves password_hash / temp_password out of `users` into server-only `credentials/{id}`.
//   node scripts/migrate-credentials.js            dry run (default): counts only
//   node scripts/migrate-credentials.js --copy     step 1: copy hashes into credentials (users untouched; safe before the new client ships)
//   node scripts/migrate-credentials.js --purge    step 2: delete password_hash / temp_password from users (after the new client is live)
// Needs Application Default Credentials for project gvd-live (or FIRESTORE_EMULATOR_HOST for a local test).
// --purge only AFTER the new client is live (the old client still reads password_hash from `users`).
// --purge refuses to run unless every user with a password_hash already has a credentials doc.
// Never prints or logs a hash or password.
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const copy = process.argv.includes('--copy');
const purge = process.argv.includes('--purge');
initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'gvd-live' });
const db = getFirestore();

(async () => {
  const snap = await db.collection('users').get();
  const c = { users: snap.size, migrated: 0, alreadyHadCredential: 0, noPassword: 0, tempPasswordsRemoved: 0 };
  for (const doc of snap.docs) {
    const u = doc.data();
    const credRef = db.collection('credentials').doc(doc.id);
    const cred = await credRef.get();
    const patch = {};
    if (u.password_hash) {
      if (cred.exists && cred.data().algo === 'scrypt') c.alreadyHadCredential++;
      else { c.migrated++; if (copy) await credRef.set({ legacy_hash: String(u.password_hash), failed_count: 0, migrated_at: new Date().toISOString() }, { merge: true }); }
      if (purge) patch.password_hash = FieldValue.delete();
    } else if (!cred.exists) c.noPassword++;
    if (u.temp_password !== undefined) { c.tempPasswordsRemoved++; if (purge) patch.temp_password = FieldValue.delete(); }
    if (purge && u.password_hash && !cred.exists) { console.error('refusing: a user has no credentials doc; run --copy first'); process.exit(1); }
    if (purge && Object.keys(patch).length) await doc.ref.update(patch);
  }
  console.log(purge ? 'PURGE' : copy ? 'COPY' : 'DRY RUN', JSON.stringify(c));
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
