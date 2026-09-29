const webpush = require('web-push');

const VAPID_PUBLIC_KEY = 'BAxW9LYu7tAuFQvd30x8Gw1adQDV27hFKnf3DikRxr9SajdzXNUwKrzaMgZk32Qwta7YGr4qAVf7b6qAkShifPM';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = 'mailto:admin@gvdcontracts.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function sendWebPushNotification(subscription, payloadData) {
  const options = {
    TTL: 86400, // 24 hour durable message lifetime (handles device offline / backgrounded)
    urgency: 'high'
  };

  const payloadString = JSON.stringify({
    title: payloadData.title || '🚨 GVD LIVE Shift Update',
    body: payloadData.body || 'You have a schedule update.',
    url: payloadData.url || '/',
    shiftId: payloadData.shiftId || null,
    siteId: payloadData.siteId || null,
    correlationId: payloadData.correlationId || 'corr_' + Date.now(),
    timestamp: payloadData.timestamp || new Date().toISOString()
  });

  try {
    const result = await webpush.sendNotification(subscription, payloadString, options);
    return {
      success: true,
      statusCode: result.statusCode || 201, // 201 Created from Apple APNs / Google FCM
      provider: subscription.endpoint.includes('apple.com') ? 'Apple APNs' : (subscription.endpoint.includes('google.com') ? 'Google FCM' : 'WebPush Provider'),
      headers: result.headers,
      body: result.body
    };
  } catch (error) {
    return {
      success: false,
      statusCode: error.statusCode || 500,
      provider: subscription.endpoint.includes('apple.com') ? 'Apple APNs' : (subscription.endpoint.includes('google.com') ? 'Google FCM' : 'WebPush Provider'),
      message: error.message || 'Push endpoint error',
      body: error.body || ''
    };
  }
}

module.exports = {
  sendWebPushNotification,
  VAPID_PUBLIC_KEY
};
