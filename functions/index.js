const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const webpush = require('web-push');

initializeApp();
const db = getFirestore();

const VAPID_PUBLIC_KEY = 'BJO5t2DJJu_uWzByWNKK8t9HlKNLMR5sB0X-uZTQrPf6iCrthlABB8JvD0FrkTWDHxIf8bumQM6W5KKEyMcFczk';
const VAPID_PRIVATE_KEY = '1ooYTjFYQJD48qoALwcuMuxVVmq2anTHK6OHhyoa_Tk';
const VAPID_SUBJECT = 'mailto:admin@gvdcontracts.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

exports.onNotificationCreated = onDocumentCreated('notifications/{notifId}', async (event) => {
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
        console.warn(`Push failed for device ${doc.id}: ${err.statusCode || err.message}`);
        if (err.statusCode === 404 || err.statusCode === 410) {
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
