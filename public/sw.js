// GVD LIVE PWA Service Worker (v5.0)

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle incoming Web Push notifications (Background & Lock Screen)
self.addEventListener('push', (event) => {
  let data = { title: '🚨 GVD LIVE Shift Update', body: 'You have a schedule update.', url: '/' };
  
  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const title = data.title || '🚨 GVD LIVE Shift Update';
  const options = {
    body: data.body || 'You have a schedule update.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [300, 100, 300],
    tag: data.shiftId ? `gvd-shift-${data.shiftId}` : `gvd-push-${Date.now()}`,
    data: {
      url: data.url || '/',
      shiftId: data.shiftId || null,
      siteId: data.siteId || null,
      timestamp: Date.now()
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Handle notification click / tap
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notifData = event.notification.data || {};
  let targetUrl = notifData.url || '/';
  if (notifData.shiftId && !targetUrl.includes('openShift')) {
    targetUrl += (targetUrl.includes('?') ? '&' : '?') + `openShift=${notifData.shiftId}`;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({
            type: 'NOTIFICATION_CLICKED',
            data: notifData
          });
          if ('focus' in client) {
            client.focus();
            if (notifData.shiftId && client.navigate) {
              client.navigate(targetUrl);
            }
            return;
          }
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
