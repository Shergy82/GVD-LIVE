// GVD LIVE Push Notification Background Worker Daemon
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const webpush = require('web-push');

initializeApp({ projectId: 'gvd-live' });
const db = getFirestore();

const VAPID_PUBLIC_KEY = 'BJO5t2DJJu_uWzByWNKK8t9HlKNLMR5sB0X-uZTQrPf6iCrthlABB8JvD0FrkTWDHxIf8bumQM6W5KKEyMcFczk';
const VAPID_PRIVATE_KEY = '1ooYTjFYQJD48qoALwcuMuxVVmq2anTHK6OHhyoa_Tk';
const VAPID_SUBJECT = 'mailto:admin@gvdcontracts.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

console.log('🚀 GVD LIVE Push Daemon listening for Firestore notifications...');

db.collection('notifications').onSnapshot(snapshot => {
  snapshot.docChanges().forEach(async change => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const docId = change.doc.id;
      const targetUserId = String(data.target_user_id);
      const title = data.title || '🚨 GVD LIVE Shift Update';
      const body = data.body || 'You have a schedule update.';
      const shiftId = data.shift_id || null;
      const siteId = data.site_id || null;

      console.log(`[PUSH DAEMON] New notification for user ${targetUserId}: "${title}"`);

      try {
        const subsSnap = await db.collection('users').doc(targetUserId).collection('subscriptions').get();
        if (subsSnap.empty) {
          console.log(`[PUSH DAEMON] No active subscriptions for user ${targetUserId}`);
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

        subsSnap.docs.forEach(async (doc) => {
          const sub = {
            endpoint: doc.data().endpoint,
            keys: doc.data().keys
          };
          if (!sub.endpoint || !sub.keys) return;

          try {
            const res = await webpush.sendNotification(sub, payload, options);
            console.log(`[PUSH DAEMON] ✅ Push delivered to device ${doc.id} (${doc.data().user_name}): HTTP ${res.statusCode}`);
          } catch (err) {
            console.warn(`[PUSH DAEMON] ❌ Push failed for device ${doc.id}: ${err.statusCode || err.message}`);
            if (err.statusCode === 404 || err.statusCode === 410) {
              console.log(`[PUSH DAEMON] Removing expired sub ${doc.id}`);
              await doc.ref.delete().catch(() => null);
            }
          }
        });
      } catch (err) {
        console.error(`[PUSH DAEMON] Error processing push: ${err.message}`);
      }
    }
  });
}, err => console.error('[PUSH DAEMON] Firestore listener error:', err));
