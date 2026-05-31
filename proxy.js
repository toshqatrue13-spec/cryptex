export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const raw = req.query.url;
  if (!raw) { res.status(400).json({ error: 'Missing ?url= parameter' }); return; }

  let targetUrl;
  try { targetUrl = decodeURIComponent(raw); } catch {
    res.status(400).json({ error: 'Invalid URL encoding' }); return;
  }

  let hostname;
  try { hostname = new URL(targetUrl).hostname; } catch {
    res.status(400).json({ error: 'Invalid URL' }); return;
  }

  // Whitelist
  const ALLOWED = [
    'api.coingecko.com',
    'api.alternative.me',
    'api.allorigins.win',
    'corsproxy.io',
    'cointelegraph.com',
    'decrypt.co',
    'cryptobriefing.com',
    'www.coindesk.com',
    'bitcoinmagazine.com',
    'cryptopotato.com',
  ];

  if (!ALLOWED.some(d => hostname === d || hostname.endsWith('.' + d))) {
    res.status(403).json({ error: 'Domain not allowed: ' + hostname }); return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const upstream = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json, application/xml, text/xml, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; CryptexBot/1.0)',
        ...(process.env.COINGECKO_API_KEY && hostname === 'api.coingecko.com'
          ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY }
          : {}),
      },
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    }

    const contentType = upstream.headers.get('content-type') || '';
    const text = await upstream.text();

    // Cache на Vercel Edge
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('Content-Type', contentType || 'application/json');
    return res.status(200).send(text);

  } catch (err) {
    const isAbort = err.name === 'AbortError';
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'Upstream timeout' : 'Proxy error: ' + err.message
    });
  }
}
