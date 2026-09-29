const { onDocumentCreated } = require('firebase-functions/v2/firestore');
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
        body: `${e.time ? 'At ' + e.time : 'Today'}${e.notes ? '\n' + e.notes : ''}`,
        created_at: new Date().toISOString()
      }));
    });
  });
  await Promise.all(writes);
  console.log(`Diary reminders sent for ${today}: ${writes.length}`);
});
