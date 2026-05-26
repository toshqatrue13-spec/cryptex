/**
 * CRYPTEX — sw.js (Service Worker)
 * HTML — завжди з мережі (Network-first)
 * Статика (fonts, images, icons) — Cache-first
 * API (/proxy) — Network-first з fallback
 */

const CACHE_VERSION = 'cryptex-v3';
const CACHE_STATIC = 'cryptex-static-v3';

// ── Install: НЕ кешуємо index.html ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll([
        '/manifest.json',
        '/icon-192.png',
        '/icon-512.png',
        '/icon-96.png',
      ]).catch(() => {})) // ігноруємо помилки якщо файли не існують
      .then(() => self.skipWaiting())
  );
});

// ── Activate: видаляємо ВСІ старі кеші ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== CACHE_STATIC)
          .map(k => {
            console.log('[SW] Видаляємо старий кеш:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ──
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Тільки GET
  if (request.method !== 'GET') return;

  // Зовнішні запити — не чіпаємо
  if (url.origin !== self.location.origin) return;

  // HTML сторінки — ЗАВЖДИ з мережі, ніколи не кешуємо
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname.endsWith('.html')
  ) {
    e.respondWith(networkOnlyWithOfflineFallback(request));
    return;
  }

  // API проксі — Network-first з коротким кешем
  if (url.pathname.startsWith('/proxy')) {
    e.respondWith(networkFirstWithCache(request));
    return;
  }

  // Іконки та маніфест — Cache-first (рідко змінюються)
  if (
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname === '/manifest.json'
  ) {
    e.respondWith(cacheFirstWithNetwork(request));
    return;
  }

  // SW і інші файли — з мережі
});

// Завжди з мережі, якщо офлайн — пустий fallback
async function networkOnlyWithOfflineFallback(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    return response;
  } catch {
    // Офлайн — пробуємо кеш як останній варіант
    const cached = await caches.match('/index.html');
    if (cached) return cached;
    return new Response('<h1>Офлайн</h1><p>Перевірте з\'єднання з інтернетом</p>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

// Network-first для API
async function networkFirstWithCache(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response(JSON.stringify({ error: 'Offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Cache-first для статики
async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 503 });
  }
}

// ── Push сповіщення ──
self.addEventListener('message', e => {
  if (e.data?.type === 'PRICE_ALERT') {
    const { coin, price, target, direction } = e.data;
    self.registration.showNotification(`CRYPTEX — Ціновий алерт 🔔`, {
      body: `${coin} ${direction === 'above' ? 'досяг' : 'впав до'} $${price.toLocaleString('en')} (ціль: $${target.toLocaleString('en')})`,
      icon: '/icon-192.png',
      badge: '/icon-96.png',
      tag: `alert-${coin}`,
      renotify: true,
      data: { url: '/' },
      actions: [
        { action: 'open', title: 'Відкрити' },
        { action: 'dismiss', title: 'Закрити' }
      ]
    });
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'open' || !e.action) {
    e.waitUntil(clients.openWindow(e.notification.data?.url || '/'));
  }
});
