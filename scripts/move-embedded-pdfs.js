/* Moves files that are stored INSIDE a GVD Live `pdfs` record (data_url) into file storage, leaving the record pointing at the file.
   Every opening of GVD Live downloads every record, so embedded files are downloaded each time.

     node scripts/move-embedded-pdfs.js backup  <folder>            save the records and files to this computer (changes nothing)
     node scripts/move-embedded-pdfs.js plan    <folder>            show what would change (changes nothing)
     node scripts/move-embedded-pdfs.js move    <folder> [--live]   do it
     node scripts/move-embedded-pdfs.js undo    <folder> [--live]   put the embedded copies back from the backup

   It works on the local emulator unless --live is given. A record is only changed after the uploaded file has been read back and matches
   the backup byte for byte, and only if nobody has changed the record in the meantime. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = req('firebase-admin/app');
const { getFirestore, FieldValue } = req('firebase-admin/firestore');
const { getStorage } = req('firebase-admin/storage');

const [mode, folder] = process.argv.slice(2);
const live = process.argv.includes('--live');
if (!['backup', 'plan', 'move', 'undo'].includes(mode) || !folder) { console.error('Use: backup|plan|move|undo <folder> [--live]'); process.exit(2); }
if (!live && !process.env.FIRESTORE_EMULATOR_HOST) { console.error('No emulator set. Add --live to work on the real GVD data.'); process.exit(2); }
if (live && process.env.FIRESTORE_EMULATOR_HOST) { console.error('--live given but an emulator is set: refusing to guess.'); process.exit(2); }
const PROJECT = live ? 'gvd-hub' : (process.env.GCLOUD_PROJECT || 'demo-gvd');
const BUCKET = live ? 'gvd-hub.firebasestorage.app' : `${PROJECT}.appspot.com`;
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket();

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
function decode(dataUrl) {
  const m = /^data:([^;,]*)(?:;[^;,]*)*?;base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  return { type: m[1] || 'application/octet-stream', buf: Buffer.from(m[2], 'base64') };
}
const safeName = n => String(n || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
const targetPath = r => `site_files/${r.site_id}/${r.id}_${safeName(r.filename)}`;
const recordsFile = path.join(folder, 'records.json');
const readBackup = () => JSON.parse(fs.readFileSync(recordsFile, 'utf8'));

async function backup() {
  if (fs.existsSync(recordsFile)) throw new Error(`${recordsFile} already exists: use a new folder so an older backup is never overwritten`);
  const snap = await db.collection('pdfs').get();
  const rows = snap.docs.filter(d => d.data().data_url);
  fs.mkdirSync(path.join(folder, 'files'), { recursive: true, mode: 0o700 });
  const out = rows.map(d => {
    const data = d.data(), f = decode(data.data_url);
    if (!f) throw new Error(`${d.id}: the embedded file cannot be read, nothing saved`);
    if (data.file_type === 'invoice') throw new Error(`${d.id}: is an invoice; invoices are not handled by this move`);
    fs.writeFileSync(path.join(folder, 'files', `${d.id}_${safeName(data.filename)}`), f.buf, { mode: 0o600 });
    return { docId: d.id, sha256: sha(f.buf), bytes: f.buf.length, type: f.type, data };
  });
  fs.writeFileSync(recordsFile, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`Backed up ${out.length} records and files to ${folder}`);
}

async function eachRecord(fn) {
  const results = { done: 0, skipped: 0, failed: 0 };
  for (const b of readBackup()) {
    try { results[await fn(b, db.collection('pdfs').doc(b.docId)) ? 'done' : 'skipped']++; }
    catch (e) { results.failed++; console.log(`FAILED ${b.docId}: ${e.message}`); }
  }
  console.log(`done ${results.done}, left alone ${results.skipped}, failed ${results.failed}`);
  if (results.failed) process.exitCode = 1;
}

const plan = () => eachRecord(async (b, ref) => {
  const s = await ref.get();
  if (!s.exists || !s.data().data_url) { console.log(`leave ${b.docId} (gone, or already moved)`); return false; }
  console.log(`move  ${b.docId}  site ${s.data().site_id}  ${Math.round(b.bytes / 1024)}KB  ${s.data().filename}\n        -> ${targetPath(s.data())}`);
  return true;
});

const move = () => eachRecord(async (b, ref) => {
  const s = await ref.get();
  if (!s.exists || !s.data().data_url) { console.log(`left alone ${b.docId} (gone, or already moved)`); return false; }
  const data = s.data(), f = decode(data.data_url);
  if (!f || sha(f.buf) !== b.sha256) throw new Error('the record no longer matches the backup; not touched');
  const to = targetPath(data);
  await bucket.file(to).save(f.buf, { resumable: false, contentType: f.type });
  const [back] = await bucket.file(to).download();
  if (sha(back) !== b.sha256) throw new Error('the uploaded file does not match; record not touched');
  // only if the record is exactly as we read it: anything changed in between (or deleted) makes this fail and leaves it as it is
  await ref.update({ storage_path: to, storage_bucket: BUCKET, data_url: FieldValue.delete() }, { lastUpdateTime: s.updateTime });
  console.log(`moved ${b.docId} ${data.filename}`);
  return true;
});

const undo = () => eachRecord(async (b, ref) => {
  const s = await ref.get();
  if (!s.exists) { console.log(`left alone ${b.docId} (deleted since: not recreated)`); return false; }
  if (s.data().data_url) return false;
  await ref.update({ data_url: b.data.data_url, storage_path: FieldValue.delete(), storage_bucket: FieldValue.delete() }, { lastUpdateTime: s.updateTime });
  console.log(`restored ${b.docId}`);
  return true;
});

({ backup, plan, move, undo })[mode]().catch(e => { console.error(e.message); process.exit(1); });
