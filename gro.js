import * as cheerio from 'cheerio';
import { rawFetch, collectCookies, buildSearchQuery, extractCandidatesCheerio, pickBest } from './common.js';

// GRO / ex Grokholsky (grokholsky.com) — Yii2-застосунок. Видача пошуку
// живе за адресою /ua/site/search/ (POST, form-encoded { _csrf, q }),
// повертає HTML-фрагмент з карточками товарів. Запит захищений CSRF-токеном,
// прив'язаним до сесії — тому спочатку тягнемо головну сторінку (щоб
// отримати Set-Cookie сесії та <meta name="csrf-token">), а тоді POST'имо
// пошук з тими самими cookie+токеном. Підтверджено вручну під час розробки.
// Puppeteer тут не потрібен — швидкий шлях повністю самодостатній.

const BASE = 'https://grokholsky.com/ua/';
const SEARCH_URL = 'https://grokholsky.com/ua/site/search/';

async function fetchSearchHtml(query) {
  const homeRes = await rawFetch(BASE);
  if (!homeRes.ok) throw new Error(`HTTP ${homeRes.status} (головна сторінка)`);
  const homeHtml = await homeRes.text();
  const cookie = collectCookies(homeRes);
  const $home = cheerio.load(homeHtml);
  const csrf = $home('meta[name="csrf-token"]').attr('content');
  if (!csrf) throw new Error('csrf-token не знайдено на головній сторінці');

  const body = new URLSearchParams({ _csrf: csrf, q: query }).toString();
  const res = await rawFetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (пошук)`);
  return res.text();
}

export async function scrapeGRO(product) {
  const query = buildSearchQuery(product);
  const now = new Date();
  const updated = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${now.toLocaleDateString('uk-UA')}`;

  try {
    const html = await fetchSearchHtml(query);
    const $ = cheerio.load(html);
    const candidates = extractCandidatesCheerio($, BASE);
    const best = pickBest(candidates, query);
    if (best) {
      return {
        store: 'GRO', price: best.price, available: best.available,
        updated, status: 'ok', url: best.url, matchedTitle: best.title,
      };
    }
    return { store: 'GRO', price: 0, available: false, updated, status: 'no-product' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[retail-parser] GRO впав: ${msg}`);
    return { store: 'GRO', price: 0, available: false, updated, status: 'error', error: msg };
  }
}
