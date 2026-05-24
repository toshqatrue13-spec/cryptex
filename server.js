/**
 * CRYPTEX — server.js
 * Локальний dev-сервер що емулює /proxy як на Vercel
 * Запуск: node server.js  або  npm start
 * Відкрий: http://localhost:3000
 */
require('dotenv').config();
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = 3000;

// ── Серверний кеш (той самий що й на Vercel) ──
const cache = new Map();

function getTTL(targetUrl) {
  if (targetUrl.includes('/global'))                               return 120;
  if (targetUrl.includes('/fng'))                                  return 120; // було 300, зменшено
  if (targetUrl.includes('/coins/markets'))                        return 60;
  if (targetUrl.includes('/search/trending'))                      return 300;
  if (targetUrl.includes('/coins/') && targetUrl.includes('/market_chart')) return 180;
  if (targetUrl.includes('/coins/'))                               return 120;
  if (targetUrl.includes('/news'))                                 return 600;
  return 60;
}

const ALLOWED = ['api.coingecko.com', 'api.alternative.me', 'cryptopanic.com', 'api.allorigins.win'];

// ── MIME типи для статичних файлів ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain',
  '.xml':  'application/xml',
};

// ── Проксі-запит до upstream ──
function fetchUpstream(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CRYPTEX-dev/1.0',
      },
      timeout: 12000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── Обробник /proxy ──
async function handleProxy(targetUrl, res) {
  // Whitelist
  let hostname;
  try { hostname = new URL(targetUrl).hostname; } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid URL' }));
  }

  if (!ALLOWED.some(d => hostname === d || hostname.endsWith('.' + d))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Domain not allowed: ' + hostname }));
  }

  const ttl = getTTL(targetUrl);

  // Кеш
  const hit = cache.get(targetUrl);
  if (hit && Date.now() - hit.ts < ttl * 1000) {
    console.log(`[CACHE HIT]  ${targetUrl.slice(0, 80)}`);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'HIT',
    });
    return res.end(JSON.stringify(hit.data));
  }

  // Upstream
  try {
    console.log(`[FETCH]      ${targetUrl.slice(0, 80)}`);
    const { status, body } = await fetchUpstream(targetUrl);

    if (status === 429) {
      console.warn('[429] Rate limit — повертаємо стейл кеш якщо є');
      const stale = cache.get(targetUrl);
      if (stale) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'STALE-429', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify(stale.data));
      }
      res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Rate limit' }));
    }

    if (status < 200 || status >= 300) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: `Upstream ${status}` }));
    }

    let data;
    try { data = JSON.parse(body); } catch {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Invalid JSON from upstream' }));
    }

    cache.set(targetUrl, { data, ts: Date.now() });
    if (cache.size > 200) {
      const oldest = [...cache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
      if (oldest) cache.delete(oldest[0]);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'MISS',
    });
    return res.end(JSON.stringify(data));

  } catch (err) {
    console.error('[ERROR]', err.message);
    const stale = cache.get(targetUrl);
    if (stale) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'STALE-ERR', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(stale.data));
    }
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Головний обробник ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    return res.end();
  }

  // /proxy?url=...
  if (pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
    }
    return handleProxy(decodeURIComponent(target), res);
  }

  // Статичні файли
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

  // Безпека: не виходимо за межі папки
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fallback до index.html (SPA)
      filePath = path.join(__dirname, 'index.html');
    }
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found');
      }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ██████╗██████╗ ██╗   ██╗██████╗ ████████╗███████╗██╗  ██╗');
  console.log('  ██╔════╝██╔══██╗╚██╗ ██╔╝██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝');
  console.log('  ██║     ██████╔╝ ╚████╔╝ ██████╔╝   ██║   █████╗   ╚███╔╝ ');
  console.log('  ██║     ██╔══██╗  ╚██╔╝  ██╔═══╝    ██║   ██╔══╝   ██╔██╗ ');
  console.log('  ╚██████╗██║  ██║   ██║   ██║        ██║   ███████╗██╔╝ ██╗');
  console.log('   ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚═╝        ╚═╝   ╚══════╝╚═╝  ╚═╝');
  console.log('');
  console.log(`  🚀 Сервер запущено: http://localhost:${PORT}`);
  console.log(`  📡 Проксі:          http://localhost:${PORT}/proxy?url=...`);
  console.log(`  🗄️  Кеш:             активний (TTL залежить від ендпоінту)`);
  console.log('');
  console.log('  Ctrl+C — зупинити');
  console.log('');
});
