/* IAS service worker: shows device notifications sent with Web Push. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const SAFE_LINK = /^\/?[\w.-]+\.html(\?[\w=&%.\-]*)?(#[\w-]*)?$/;

self.addEventListener('push', (event) => {
  let n = {};
  try { n = event.data ? event.data.json() : {}; } catch (_) { /* ignore broken payload */ }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.find((w) => w.visibilityState === 'visible' && w.focused);
    if (visible) { // the user is looking at IAS: the bell updates, no device notification needed
      wins.forEach((w) => w.postMessage({ type: 'ias-notify' }));
      return;
    }
    wins.forEach((w) => w.postMessage({ type: 'ias-notify' }));
    // How long it stays on screen is up to the browser and the OS notification settings.
    await self.registration.showNotification(n.title || 'IAS', {
      body: [n.source, n.body].filter(Boolean).join(' · '),
      tag: n.id ? 'ias-' + n.id : undefined,
      data: { link: n.link || 'home.html' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let link = (event.notification.data && event.notification.data.link) || 'home.html';
  if (!SAFE_LINK.test(link)) link = 'home.html';
  const url = new URL(link.replace(/^\//, ''), self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); if ('navigate' in w) { try { await w.navigate(url); } catch (_) {} } return; }
    }
    await self.clients.openWindow(url);
  })());
});
