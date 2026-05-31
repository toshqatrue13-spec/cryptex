// Vercel Serverless Function — замінює server.js
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Whitelist — дозволені API
  const allowed = [
    'api.coingecko.com',
    'api.alternative.me',
  ];

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const isAllowed = allowed.some(domain => targetUrl.hostname.endsWith(domain));
  if (!isAllowed) {
    return res.status(403).json({ error: 'Domain not allowed' });
  }

try {
    const response = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CryptexBot/1.0)',
        'Accept': 'application/json',
        ...(process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {}),
      },
      // Timeout 15 sec
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Upstream error: ${response.status}` 
      });
    }

    const data = await response.json();
    
    // Cache на Vercel Edge — 60 секунд
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(data);

  } catch (error) {
    if (error.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Upstream timeout' });
    }
    return res.status(500).json({ error: error.message });
  }
}
