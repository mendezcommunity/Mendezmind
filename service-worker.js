/**
 * Mendez Community — Service Worker v1
 * Cache-first strategy for offline support.
 * Caches: index.html, silver-task.html, manifest.json, icons, fonts.
 */

const CACHE_VERSION = 'mendez-v1';
const BASE = '/Mendezmind/';

const PRECACHE_URLS = [
  BASE,
  BASE + 'index.html',
  BASE + 'silver-task.html',
  BASE + 'manifest.json',
  BASE + 'icon-192.svg',
  BASE + 'icon-512.svg',
];

// ── Install: precache core assets ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn('[SW] Precache partial failure (ok on first install):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first, network fallback ───────────────────────────────────
self.addEventListener('fetch', event => {
  // Only handle GET requests for same-origin or CDN assets
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Skip Cloud Function API calls — always network
  if (url.hostname.includes('cloudfunctions.net') ||
      url.hostname.includes('firebaseapp.com') ||
      url.pathname.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Cache successful responses for HTML/CSS/JS/SVG/JSON
        if (response && response.status === 200) {
          const ct = response.headers.get('content-type') || '';
          if (ct.includes('html') || ct.includes('javascript') ||
              ct.includes('css') || ct.includes('svg') || ct.includes('json')) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
          }
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match(BASE + 'index.html');
        }
      });
    })
  );
});

// ── Push notifications (future use) ────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Mendez Community', {
      body: data.body || 'You have a new update.',
      icon: BASE + 'icon-192.svg',
      badge: BASE + 'icon-192.svg',
      tag: 'mendez-notification',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(BASE));
});
