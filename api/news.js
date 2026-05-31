/**
 * CRYPTEX — /api/news.js
 * Серверний фетч RSS новин — обходить CORS та блокування
 */
 
const RSS_SOURCES = [
  { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' },
  { url: 'https://decrypt.co/feed', name: 'Decrypt' },
  { url: 'https://cryptobriefing.com/feed/', name: 'CryptoBriefing' },
  { url: 'https://cryptopotato.com/feed/', name: 'CryptoPotato' },
  { url: 'https://ambcrypto.com/feed/', name: 'AMBCrypto' },
  { url: 'https://www.newsbtc.com/feed/', name: 'NewsBTC' },
];
 
function parseRSS(xml, sourceName) {
  const items = [];
  const itemRegex = /<item[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRegex) || [];
 
  for (const item of matches.slice(0, 10)) {
    const getTag = (tag) => {
      const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'));
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const getLinkTag = () => {
      // <link> може бути self-closing або між тегами
      const m = item.match(/<link>([^<]+)<\/link>|<link\s[^>]*href="([^"]+)"/i);
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const title = getTag('title');
    const url = getLinkTag() || getTag('guid');
    const date = getTag('pubDate') || getTag('dc:date');
    if (title && title.length > 5) {
      items.push({ title, url, date, source: sourceName });
    }
  }
  return items;
}
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
 
  const errors = [];
 
  for (const source of RSS_SOURCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
 
      const response = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Referer': 'https://www.google.com/',
        },
      });
      clearTimeout(timeout);
 
      if (!response.ok) {
        errors.push(`${source.name}: ${response.status}`);
        continue;
      }
 
      const xml = await response.text();
      if (!xml.includes('<item')) {
        errors.push(`${source.name}: no items in RSS`);
        continue;
      }
 
      const items = parseRSS(xml, source.name);
      if (items.length >= 3) {
        // Кешуємо на 10 хвилин
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({ items, source: source.name });
      }
    } catch (e) {
      errors.push(`${source.name}: ${e.message}`);
    }
  }
 
  // Всі джерела впали
  return res.status(503).json({ error: 'All RSS sources failed', details: errors });
}
