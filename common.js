// Спільні утиліти для всіх парсерів роздрібних магазинів.
//
// Архітектура: для кожного магазину намагаємось спочатку зробити швидкий
// запит (plain fetch + cheerio). Якщо сторінка не серверно-рендериться
// (SPA-пошук на JS) або швидкий шлях не дав кандидатів — падаємо в
// Puppeteer (headless Chrome), який рендерить сторінку по-справжньому і
// вміє друкувати запит у видиме поле пошуку.
//
// Це свідомий компроміс: ми не завжди знаємо наперед, чи сайт
// серверно-рендерить видачу пошуку. Generic-екстрактор шукає на сторінці
// посилання на товар (текст 6-160 символів) поруч з ціною у форматі
// "12 345 ₴" / "12345 грн" — без прив'язки до конкретних CSS-класів,
// які на українських e-commerce сайтах міняються часто.

import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;
const PUPPETEER_NAV_TIMEOUT_MS = 20000;

let browserPromise = null;
export async function getBrowser() {
  if (!browserPromise) {
    const puppeteer = await import('puppeteer');
    browserPromise = puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

export async function fetchHtml(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------- Ціни ----------

// Знаходить усі "грн-подібні" числа у шматку тексту: "65 999 ₴", "65999грн", "65 999 UAH"
const PRICE_RE = /(\d[\d\s ]{1,7})\s*(?:₴|грн\.?|uah)/gi;

export function extractPrices(text) {
  const out = [];
  let m;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text))) {
    const n = parseInt(m[1].replace(/[\s ]/g, ''), 10);
    if (n && n > 50 && n < 3_000_000) out.push(n);
  }
  return out;
}

const OUT_OF_STOCK_RE = /немає в наявн|нет в наличии|під замовлення|очікується|out of stock|товар закінчився|тимчасово відсутн/i;

// ---------- Нормалізація запиту з товару CRM ----------

export function buildSearchQuery(product) {
  // Прибираємо суфікс регіону (EU/DE/US/...) та лишаємо модель + пам'ять +
  // колір — так найкраще працює пошук на сайтах магазинів.
  let base = product.model || product.name;
  const parts = [base];
  if (product.tags?.storage && !base.includes(product.tags.storage)) parts.push(product.tags.storage);
  if (product.tags?.color && !base.toLowerCase().includes(product.tags.color.toLowerCase())) parts.push(product.tags.color);
  let q = parts.join(' ')
    .replace(/\b(EU|DE|DACH|INDIA|US|QLA)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return q;
}

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/["'()]/g, ' ')
    .split(/[\s,/]+/)
    .filter(w => w.length > 1);
}

// Проста оцінка збігу: частка токенів запиту, які знайшлись у назві кандидата.
export function scoreMatch(query, title) {
  const qTokens = tokenize(query);
  const tTokens = new Set(tokenize(title));
  if (qTokens.length === 0) return 0;
  let hit = 0;
  for (const t of qTokens) if (tTokens.has(t)) hit++;
  return hit / qTokens.length;
}

export const MATCH_THRESHOLD = 0.6; // мін. частка токенів запиту, які мають збігтись

// ---------- Генерик-екстрактор кандидатів із cheerio ($) ----------
// Повертає список { title, url, price, available }
export function extractCandidatesCheerio($, baseUrl, opts = {}) {
  const maxCandidates = opts.maxCandidates ?? 400;
  const candidates = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    if (candidates.length >= maxCandidates) return;
    const $a = $(el);
    const text = $a.text().replace(/\s+/g, ' ').trim();
    if (text.length < 6 || text.length > 160) return;
    const href = $a.attr('href');
    if (!href) return;

    // Шукаємо ціну в найближчому "контейнері картки" — до 4 рівнів вгору.
    let $container = $a;
    let priceText = '';
    for (let i = 0; i < 4 && priceText === ''; i++) {
      $container = $container.parent();
      if ($container.length === 0) break;
      const t = $container.text();
      PRICE_RE.lastIndex = 0;
      if (PRICE_RE.test(t)) priceText = t;
    }
    if (!priceText) return;

    const prices = extractPrices(priceText);
    if (prices.length === 0) return;

    let url;
    try { url = new URL(href, baseUrl).toString(); } catch { return; }
    const key = url + '|' + text;
    if (seen.has(key)) return;
    seen.add(key);

    candidates.push({
      title: text,
      url,
      price: Math.min(...prices),
      available: !OUT_OF_STOCK_RE.test(priceText),
    });
  });

  return candidates;
}

// ---------- Генерик-екстрактор кандидатів у живому DOM (Puppeteer page) ----------
export async function extractCandidatesPuppeteer(page, opts = {}) {
  const maxCandidates = opts.maxCandidates ?? 400;
  return page.evaluate((maxCandidates) => {
    const PRICE_RE = /(\d[\d\s ]{1,7})\s*(?:₴|грн\.?|uah)/gi;
    const OUT_RE = /немає в наявн|нет в наличии|під замовлення|очікується|out of stock|товар закінчився|тимчасово відсутн/i;
    function extractPrices(text) {
      const out = [];
      let m; PRICE_RE.lastIndex = 0;
      while ((m = PRICE_RE.exec(text))) {
        const n = parseInt(m[1].replace(/[\s ]/g, ''), 10);
        if (n && n > 50 && n < 3000000) out.push(n);
      }
      return out;
    }
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const out = [];
    const seen = new Set();
    for (const a of anchors) {
      if (out.length >= maxCandidates) break;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 6 || text.length > 160) continue;
      let container = a;
      let priceText = '';
      for (let i = 0; i < 4 && !priceText; i++) {
        container = container.parentElement;
        if (!container) break;
        const t = container.textContent || '';
        PRICE_RE.lastIndex = 0;
        if (PRICE_RE.test(t)) priceText = t;
      }
      if (!priceText) continue;
      const prices = extractPrices(priceText);
      if (prices.length === 0) continue;
      let url;
      try { url = new URL(a.getAttribute('href'), location.href).toString(); } catch { continue; }
      const key = url + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title: text, url, price: Math.min(...prices), available: !OUT_RE.test(priceText) });
    }
    return out;
  }, maxCandidates);
}

export function pickBest(candidates, query) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = scoreMatch(query, c.title);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (best && bestScore >= MATCH_THRESHOLD) return { ...best, score: bestScore };
  return null;
}

export async function withPuppeteerPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultNavigationTimeout(PUPPETEER_NAV_TIMEOUT_MS);
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// Друк запиту у перше видиме поле пошуку на сторінці (без прив'язки до
// конкретного сайту) — перебирає типові селектори.
const SEARCH_INPUT_SELECTORS = [
  'input[type="search"]',
  'input[name="search"]',
  'input[name*="search" i]',
  'input[placeholder*="Пошук" i]',
  'input[placeholder*="поиск" i]',
  'input[placeholder*="search" i]',
  'input#search',
  'input.search-input',
];

export async function typeIntoSiteSearch(page, query) {
  for (const sel of SEARCH_INPUT_SELECTORS) {
    const el = await page.$(sel);
    if (!el) continue;
    const visible = await el.evaluate(node => {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }).catch(() => false);
    if (!visible) continue;
    try {
      await el.click({ clickCount: 3 });
      await el.type(query, { delay: 20 });
      await Promise.all([
        page.keyboard.press('Enter'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: PUPPETEER_NAV_TIMEOUT_MS }).catch(() => null),
      ]);
      // невелика пауза для дорендеру SPA-списку
      await new Promise(r => setTimeout(r, 1200));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

// ---------- Оркестратор одного магазину ----------
// config:
//   name          — назва магазину (як у RetailStore.store)
//   baseUrl       — головна сторінка (для fallback через Puppeteer)
//   searchUrl(q)  — функція, що будує URL сторінки видачі пошуку (пробуємо plain fetch)
//   usePuppeteerFallback — чи пробувати headless-браузер, якщо fetch не дав збігу
//
// Повертає { store, price, available, updated, status, url?, matchedTitle? }
export async function scrapeStore(config, product) {
  const query = buildSearchQuery(product);
  const now = new Date();
  const updated = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${now.toLocaleDateString('uk-UA')}`;

  // 1) швидкий шлях — plain fetch + cheerio
  try {
    const url = config.searchUrl(query);
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const candidates = extractCandidatesCheerio($, url);
    const best = pickBest(candidates, query);
    if (best) {
      return {
        store: config.name, price: best.price, available: best.available,
        updated, status: 'ok', url: best.url, matchedTitle: best.title,
      };
    }
  } catch (e) {
    // тихо падаємо в Puppeteer-шлях нижче
  }

  // 2) fallback — headless-браузер із набором тексту у пошук сайту
  if (config.usePuppeteerFallback !== false) {
    try {
      const result = await withPuppeteerPage(async (page) => {
        await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
        const typed = await typeIntoSiteSearch(page, query);
        if (!typed) return null;
        const candidates = await extractCandidatesPuppeteer(page);
        return pickBest(candidates, query);
      });
      if (result) {
        return {
          store: config.name, price: result.price, available: result.available,
          updated, status: 'ok', url: result.url, matchedTitle: result.title,
        };
      }
      return { store: config.name, price: 0, available: false, updated, status: 'no-product' };
    } catch (e) {
      return { store: config.name, price: 0, available: false, updated, status: 'error' };
    }
  }

  return { store: config.name, price: 0, available: false, updated, status: 'no-product' };
}

export { cheerio };
