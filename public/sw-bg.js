/* eslint-disable no-undef */
// Service Worker extension for background downloads & completion notifications

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'SHOW_NOTIFICATION') {
    const title = data.title || 'Sideload Transfer Complete';
    const options = {
      body: data.body || 'Your Microsoft Store package download has finished.',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      tag: data.tag || 'sideload-download',
      renotify: true,
      data: { url: data.url || '/' },
    };
    event.waitUntil(self.registration.showNotification(title, options));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});

self.addEventListener('backgroundfetchsuccess', (event) => {
  const bgFetch = event.registration;
  event.waitUntil(
    (async () => {
      try {
        const records = await bgFetch.matchAll();
        const cache = await caches.open('sideload-offline-packages');
        for (const record of records) {
          const response = await record.responseReady;
          if (response && response.ok) {
            await cache.put(record.request, response.clone());
          }
        }
        if (typeof bgFetch.updateUI === 'function') {
          await bgFetch.updateUI({ title: `Completed: ${bgFetch.id}` });
        }
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) {
          client.postMessage({
            type: 'BGFETCH_SUCCESS',
            id: bgFetch.id,
          });
        }
        await self.registration.showNotification('Background Download Complete', {
          body: `Package ${bgFetch.id} is ready to save.`,
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          tag: `bg-${bgFetch.id}`,
          renotify: true,
        });
      } catch (err) {
        console.error('backgroundfetchsuccess handler error:', err);
      }
    })()
  );
});

self.addEventListener('backgroundfetchfail', (event) => {
  const bgFetch = event.registration;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({
          type: 'BGFETCH_FAIL',
          id: bgFetch.id,
          failureReason: bgFetch.failureReason || 'Transfer failed',
        });
      }
      await self.registration.showNotification('Background Download Interrupted', {
        body: `Transfer ${bgFetch.id} was interrupted and can be resumed in Sideload.`,
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        tag: `bg-${bgFetch.id}`,
      });
    })()
  );
});

self.addEventListener('backgroundfetchclick', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/?tab=transfers');
      return undefined;
    })
  );
});
