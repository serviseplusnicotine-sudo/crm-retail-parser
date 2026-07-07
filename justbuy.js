import { rawFetch, buildSearchQuery, scoreMatch, MATCH_THRESHOLD, isAccessoryTitle } from './common.js';

// JustBuy (justbuy.com.ua) — Next.js-фронтенд, видача пошуку рендериться
// клієнтським JS, тож у сирому HTML цін немає. Але сайт ходить у власний
// JSON API: POST https://api.justbuy.com.ua/global-search/content
// { "query": "..." } -> { responseData: { products: { data: [...] } } }.
// Знайдено через перехоплення fetch/XHR у реальному пошуковому полі сайту.
// Puppeteer тут не потрібен — це чистий і надійний JSON-шлях.

const API_URL = 'https://api.justbuy.com.ua/global-search/content';
const SEARCH_PAGE = (q) => `https://justbuy.com.ua/ua/search?q=${encodeURIComponent(q)}`;

export async function scrapeJustBuy(product) {
  const query = buildSearchQuery(product);
  const now = new Date();
  const updated = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${now.toLocaleDateString('uk-UA')}`;

  try {
    const res = await rawFetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = json?.responseData?.products?.data || [];

    const queryIsAccessory = isAccessoryTitle(query);
    let best = null;
    let bestScore = 0;
    for (const p of items) {
      const title = p?.nameI18n?.ua || p?.nameI18n?.ru || p?.nameI18n?.en || '';
      let s = scoreMatch(query, title);
      if (!queryIsAccessory && isAccessoryTitle(title)) s *= 0.5;
      if (s > bestScore) {
        bestScore = s;
        best = {
          title,
          price: p.price,
          available: p.availabilityStatus === 'IN_STOCK',
        };
      }
    }

    if (best && bestScore >= MATCH_THRESHOLD) {
      return {
        store: 'JustBuy', price: best.price, available: best.available,
        updated, status: 'ok', url: SEARCH_PAGE(query), matchedTitle: best.title,
      };
    }
    return { store: 'JustBuy', price: 0, available: false, updated, status: 'no-product' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[retail-parser] JustBuy впав: ${msg}`);
    return { store: 'JustBuy', price: 0, available: false, updated, status: 'error', error: msg };
  }
}
