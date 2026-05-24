/**
 * CRYPTEX — /api/proxy.js
 * Серверний проксі з кешем для CoinGecko та Alternative.me
 * Захищає від 429 Too Many Requests:
 *   - Vercel s-maxage кешує відповідь на CDN рівні
 *   - In-memory Map кешує між "теплими" інвокаціями
 *   - Різний TTL для різних ендпоінтів
 */

// In-memory cache (живе поки функція "тепла" на Vercel)
const MEM = new Map();

// TTL в секундах для різних ендпоінтів
function getTTL(url) {
  if (url.includes('/global'))           return 120;  // 2 хв
  if (url.includes('/fng'))              return 300;  // 5 хв
  if (url.includes('/coins/markets'))    return 60;   // 1 хв
  if (url.includes('/search/trending'))  return 300;  // 5 хв
  if (url.includes('/coins/') && url.includes('/market_chart')) return 180; // 3 хв
  if (url.includes('/coins/'))           return 120;  // 2 хв (detail)
  if (url.includes('/news'))             return 600;  // 10 хв
  return 60; // default
}

// Whitelist дозволених доменів (безпека)
const ALLOWED = [
  'api.coingecko.com',
  'api.alternative.me',
  'cryptopanic.com',
];

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET')     { res.status(405).json({ error: 'Method not allowed' }); return; }

  const raw = req.query.url;
  if (!raw) { res.status(400).json({ error: 'Missing ?url= parameter' }); return; }

  let targetUrl;
  try { targetUrl = decodeURIComponent(raw); } catch {
    res.status(400).json({ error: 'Invalid URL encoding' }); return;
  }

  // Whitelist перевірка
  let hostname;
  try { hostname = new URL(targetUrl).hostname; } catch {
    res.status(400).json({ error: 'Invalid URL' }); return;
  }
  if (!ALLOWED.some(d => hostname === d || hostname.endsWith('.' + d))) {
    res.status(403).json({ error: 'Domain not allowed: ' + hostname }); return;
  }

  const ttl = getTTL(targetUrl);

  // Перевіряємо in-memory кеш
  const cached = MEM.get(targetUrl);
  if (cached && Date.now() - cached.ts < ttl * 1000) {
    res.setHeader('X-Cache', 'HIT-MEMORY');
    res.setHeader('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 5}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(cached.data);
  }

  // Запит до API
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const upstream = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CRYPTEX/1.0 (cryptex.com.ua)',
        // Якщо є API ключ — вставляється тут через env variable
        ...(process.env.COINGECKO_API_KEY
          ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY }
          : {}),
      },
    });
    clearTimeout(timeout);

    // Якщо upstream повертає 429 — пробуємо віддати застарілий кеш
    if (upstream.status === 429) {
      const stale = MEM.get(targetUrl);
      if (stale) {
        res.setHeader('X-Cache', 'STALE-429');
        res.setHeader('Cache-Control', `public, s-maxage=30, stale-while-revalidate=120`);
        return res.status(200).json(stale.data);
      }
      res.setHeader('Retry-After', upstream.headers.get('Retry-After') || '60');
      return res.status(429).json({ error: 'Rate limit — спробуй пізніше' });
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    }

    const data = await upstream.json();

    // Зберігаємо в пам'яті
    MEM.set(targetUrl, { data, ts: Date.now() });

    // Видаляємо старі записи (проста LRU — якщо більше 100 ключів)
    if (MEM.size > 100) {
      const oldest = [...MEM.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
      if (oldest) MEM.delete(oldest[0]);
    }

    // Vercel CDN кешує по s-maxage
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 5}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);

  } catch (err) {
    // Timeout або мережева помилка — стейл кеш
    const stale = MEM.get(targetUrl);
    if (stale) {
      res.setHeader('X-Cache', 'STALE-ERROR');
      return res.status(200).json(stale.data);
    }
    const isAbort = err.name === 'AbortError';
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'Upstream timeout' : 'Proxy error: ' + err.message
    });
  }
}
