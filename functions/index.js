const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { getStorage } = require('firebase-admin/storage');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const webpush = require('web-push');

initializeApp();
const db = getFirestore();

const VAPID_PUBLIC_KEY = 'BAxW9LYu7tAuFQvd30x8Gw1adQDV27hFKnf3DikRxr9SajdzXNUwKrzaMgZk32Qwta7YGr4qAVf7b6qAkShifPM';
const VAPID_PRIVATE_KEY_SECRET = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = 'mailto:admin@gvdcontracts.com';


exports.onNotificationCreated = onDocumentCreated({ document: 'notifications/{notifId}', secrets: [VAPID_PRIVATE_KEY_SECRET] }, async (event) => {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY_SECRET.value());
  const snapshot = event.data;
  if (!snapshot) return;

  const data = snapshot.data();
  const targetUserId = String(data.target_user_id);
  const title = data.title || '🚨 GVD LIVE Shift Update';
  const body = data.body || 'You have a schedule update.';
  const shiftId = data.shift_id || null;
  const siteId = data.site_id || null;

  console.log(`Processing push notification for user ${targetUserId}: "${title}"`);

  try {
    const subsSnap = await db.collection('users').doc(targetUserId).collection('subscriptions').get();
    if (subsSnap.empty) {
      console.log(`No active subscriptions found for user ${targetUserId}`);
      return;
    }

    const payload = JSON.stringify({
      title,
      body,
      url: '/',
      shiftId,
      siteId,
      timestamp: Date.now()
    });

    const options = {
      TTL: 86400,
      urgency: 'high'
    };

    const promises = subsSnap.docs.map(async (doc) => {
      const sub = {
        endpoint: doc.data().endpoint,
        keys: doc.data().keys
      };
      if (!sub.endpoint || !sub.keys) return;

      try {
        const res = await webpush.sendNotification(sub, payload, options);
        console.log(`Push sent to device ${doc.id}: HTTP ${res.statusCode}`);
      } catch (err) {
        let host = 'unknown';
        try { host = new URL(sub.endpoint).host; } catch (e) {}
        console.warn(`Push failed for device ${doc.id} (${host}, updated ${doc.data().updated_at}): ${err.statusCode || err.message} body=${String(err.body || '').slice(0, 300)}`);
        if (err.statusCode === 404 || err.statusCode === 410 || String(err.body || '').includes('VapidPkHashMismatch')) {
          console.log(`Cleaning expired subscription ${doc.id}`);
          await doc.ref.delete().catch(() => null);
        }
      }
    });

    await Promise.all(promises);
  } catch (err) {
    console.error(`Error in onNotificationCreated: ${err.message}`, err);
  }
});

function fmtWindow(t) {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(t || '');
  if (!m) return t;
  const h = n => { const x = parseInt(n, 10); return (x % 12 || 12) + (x >= 12 ? 'pm' : 'am'); };
  return `${h(m[1])} and ${h(m[3])}`;
}

// 7am (UK time) diary reminders: one notification per assignee, which onNotificationCreated then pushes.
exports.sendDiaryReminders = onSchedule({ schedule: '0 7 * * *', timeZone: 'Europe/London' }, async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const snap = await db.collection('diary').where('date', '==', today).get();
  const writes = [];
  snap.docs.forEach(doc => {
    const e = doc.data();
    if (e.reminder_7am === false) return;
    (e.assignee_ids || []).forEach(uid => {
      writes.push(db.collection('notifications').add({
        target_user_id: String(uid),
        title: '⏰ Today: ' + (e.title || 'Diary entry'),
        body: `${e.time ? 'Between ' + fmtWindow(e.time) : 'Today'}${e.notes ? '\n' + e.notes : ''}`,
        created_at: new Date().toISOString()
      }));
    });
  });
  await Promise.all(writes);
  console.log(`Diary reminders sent for ${today}: ${writes.length}`);
});

// Serves site documents from our own domain (/files/<pdfDocId>) so phones treat them as normal downloads.
exports.siteFile = onRequest({ memory: '512MiB', timeoutSeconds: 120 }, async (req, res) => {
  try {
    const id = decodeURIComponent((req.path || '').split('/').filter(Boolean).pop() || '');
    if (!id) return res.status(400).send('Missing file id');
    const isPhoto = id.startsWith('photo_');
    const snap = await db.collection(isPhoto ? 'photos' : 'pdfs').doc(id).get();
    const d = snap.exists ? snap.data() : null;
    if (!d || !d.storage_path) return res.status(404).send('File not found');

    const bucketName = String(d.storage_bucket || '').replace(/^gs:\/\//, '');
    const file = bucketName ? getStorage().bucket(bucketName).file(d.storage_path) : getStorage().bucket().file(d.storage_path);
    const [meta] = await file.getMetadata();
    const isPdf = /\.pdf$/i.test(d.filename || '');
    const inline = isPhoto ? req.query.dl !== '1' : isPdf;
    res.set('Content-Type', isPdf ? 'application/pdf' : (meta.contentType || 'application/octet-stream'));
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.filename || 'file')}`);
    if (meta.size) res.set('Content-Length', String(meta.size));
    res.set('Cache-Control', 'private, max-age=300');
    file.createReadStream()
      .on('error', err => { console.error('siteFile stream error', err.message); if (!res.headersSent) res.status(500).send('Could not read file'); else res.end(); })
      .pipe(res);
  } catch (err) {
    console.error('siteFile error', err.message);
    if (!res.headersSent) res.status(500).send('Could not open file');
  }
});

// Invoices inbox (Gmail) - imports emailed PDF invoices automatically
exports.importInvoiceEmails = require('./invoiceMail').importInvoiceEmails;
