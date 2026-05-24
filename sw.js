/**
 * CRYPTEX — sw.js (Service Worker)
 * Стратегія: Network-first для API, Cache-first для статики
 */

const CACHE_NAME = 'cryptex-v1';
const CACHE_NAME_STATIC = 'cryptex-static-v1';

// Статичні ресурси — кешуємо назавжди
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── Install: кешуємо статику ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME_STATIC)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: чистимо старі кеші ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CACHE_NAME_STATIC)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: розумна стратегія ──
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Тільки GET
  if (request.method !== 'GET') return;

  // /proxy запити (API дані) — Network-first, fallback до кешу
  if (url.pathname.startsWith('/proxy')) {
    e.respondWith(networkFirstWithCache(request, CACHE_NAME, 300));
    return;
  }

  // Зовнішні API — пропускаємо (обробляє /proxy)
  if (!url.origin.includes(self.location.origin)) return;

  // Статичні файли — Cache-first
  if (
    url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico')
  ) {
    e.respondWith(cacheFirstWithNetwork(request));
    return;
  }
});

// Network-first: пробує мережу, при помилці — кеш
async function networkFirstWithCache(request, cacheName, ttlSeconds) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Зберігаємо з міткою часу в заголовку
      const responseToCache = response.clone();
      const headers = new Headers(responseToCache.headers);
      headers.set('sw-cached-at', Date.now().toString());
      const body = await responseToCache.blob();
      cache.put(request, new Response(body, { status: response.status, headers }));
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Cache-first: кеш → мережа → зберігаємо
async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline fallback — повертаємо index.html
    const fallback = await caches.match('/index.html');
    return fallback || new Response('Offline', { status: 503 });
  }
}

// ── Push сповіщення від price alerts ──
self.addEventListener('message', e => {
  if (e.data?.type === 'PRICE_ALERT') {
    const { coin, price, target, direction } = e.data;
    self.registration.showNotification(`CRYPTEX — Ціновий алерт 🔔`, {
      body: `${coin} ${direction === 'above' ? 'досяг' : 'впав до'} $${price.toLocaleString('en')} (ціль: $${target.toLocaleString('en')})`,
      icon: '/manifest.json',
      badge: '/manifest.json',
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
