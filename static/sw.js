/* Service worker HR-помощника (PWA).
   Стратегия:
   - навигация (HTML) — network-first + офлайн-фолбэк (свежие данные важнее);
   - статика (/static/) — stale-while-revalidate (быстро из кэша, обновляем в фоне);
   - API / SSE / WebSocket / не-GET / чужой origin — НЕ трогаем (всегда сеть, без кэша).
   Динамический контент (сообщения, документы, ответы ИИ) не кэшируется. */
const CACHE = 'hrhelper-static-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/static/css/styles.css',
  '/static/css/mobile.css',
  '/static/js/scripts.js',
  '/static/images/pwa-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== location.origin) return;   // только свой origin, GET
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  if ((req.headers.get('accept') || '').includes('text/event-stream')) return;  // SSE

  // Навигация — свежий HTML, при офлайне — заглушка.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Статика — из кэша сразу, параллельно обновляем.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.open(CACHE).then((cache) => cache.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      }))
    );
  }
});

/* ===== Web Push: системные уведомления ===== */
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) {}
    // Если приложение открыто и на виду — не дублируем системным уведомлением
    // (в самом приложении показывается toast).
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.focused || c.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'HR-помощник', {
      body: data.body || '',
      icon: '/static/images/pwa-192.png',
      badge: '/static/images/pwa-192.png',
      tag: data.tag || 'hr-notify',
      renotify: true,
      data: { url: data.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (c.url.indexOf(url) >= 0 && 'focus' in c) return c.focus();
    }
    if (wins.length && 'focus' in wins[0]) {
      await wins[0].focus();
      if (wins[0].navigate) { try { await wins[0].navigate(url); } catch (e) {} }
      return;
    }
    return self.clients.openWindow(url);
  })());
});
