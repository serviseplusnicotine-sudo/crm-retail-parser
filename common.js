// Спільні утиліти для всіх парсерів роздрібних магазинів.
//
// Архітектура: для кожного магазину намагаємось спочатку зробити швидкий
// запит (plain fetch + cheerio, або власна логіка магазину через rawFetch).
// Якщо сторінка не серверно-рендериться (SPA-пошук на JS) або швидкий шлях
// не дав кандидатів — падаємо в Puppeteer (headless Chrome), який рендерить
// сторінку по-справжньому і вміє друкувати запит у видиме поле пошуку.
//
// Це свідомий компроміс: ми не завжди знаємо наперед, чи сайт
// серверно-рендерить видачу пошуку. Generic-екстрактор шукає на сторінці
// посилання на товар (текст 6-160 символів) поруч з ціною у форматі
// "12 345 ₴" / "12345 грн" — без прив'язки до конкретних CSS-класів,
// які на українських e-commerce сайтах міняються часто.
//
// Puppeteer — важкий ресурс (headless Chrome), тому одночасна кількість
// відкритих сторінок обмежена через acquirePuppeteerSlot/releasePuppeteerSlot
// нижче — інакше на невеликому сервері (512MB-1GB RAM) кілька одночасних
// Chrome-сторінок можуть вивалити процес по OOM (перевірено на практиці).

import * as cheerio from 'cheerio';
import { ProxyAgent } from 'undici';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;
const PUPPETEER_NAV_TIMEOUT_MS = 20000;

function withTimeout(promise, ms, message) {
      return new Promise((resolve, reject) => {
              const t = setTimeout(() => reject(new Error(message)), ms);
              promise.then(
                        (v) => { clearTimeout(t); resolve(v); },
                        (e) => { clearTimeout(t); reject(e); }
                      );
      });
}

// ---------- Проксі-пул (опційно) ----------
// БАГ (знайдено користувачем): iStore/МТА блокують запити з IP датацентру
// (403) — один-єдиний PROXY_URL іноді теж потрапляє під той самий бан
// (дешеві датацентр-проксі часто вже у блок-листах антибот-систем), і тоді
// відмінностей від "прямого" запиту з Render немає ніякої. Замість одного
// проксі підтримуємо ПУЛ (PROXY_URLS, через кому чи новий рядок) — кожен
// fetch-запит (rawFetch) випадково бере ОДИН проксі з пулу, тож якщо
// конкретний IP забанений — наступний запит піде вже з іншого. Для
// Puppeteer прив'язка до проксі відбувається на рівні ЗАПУСКУ браузера
// (--proxy-server можна задати лише один раз при старті Chrome), тому там
// один проксі з пулу обирається випадково при кожному (пере)запуску
// браузера — з часом (crash-recovery теж рестартує браузер) різні проксі
// встигають побувати в ролі "поточного".
// PROXY_URL (однина) лишається як fallback для зворотної сумісності.
function parseProxyPool() {
      const raw = process.env.PROXY_URLS || process.env.PROXY_URL;
      if (!raw) return [];
      const urls = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      const configs = [];
      for (const url of urls) {
              try {
                        const u = new URL(url);
                        configs.push({
                                    href: url,
                                    hostPort: `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`,
                                    username: decodeURIComponent(u.username || ''),
                                    password: decodeURIComponent(u.password || ''),
                        });
              } catch {
                        console.error('[retail-parser] проксі URL некоректний, пропускаю:', url);
              }
      }
      return configs;
}

const proxyPool = parseProxyPool();
const proxyAgents = proxyPool.map((cfg) => new ProxyAgent(cfg.href));
if (proxyPool.length > 0) {
      console.log(`[retail-parser] проксі-пул увімкнено: ${proxyPool.length} шт. (${proxyPool.map((p) => p.hostPort).join(', ')})`);
}

export function hasProxy() {
      return proxyPool.length > 0;
}

function pickRandomProxy() {
      if (proxyPool.length === 0) return null;
      const i = Math.floor(Math.random() * proxyPool.length);
      return { config: proxyPool[i], agent: proxyAgents[i] };
}

const BROWSER_LAUNCH_TIMEOUT_MS = 30000;
const NEW_PAGE_TIMEOUT_MS = 15000;
const PAGE_WORK_TIMEOUT_MS = 45000;

let browserPromise = null;
let currentBrowserProxyConfig = null;

async function launchBrowser() {
      const puppeteer = await import('puppeteer');
      const args = [
              '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
              '--disable-gpu', '--disable-extensions', '--disable-background-networking',
              '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
              '--disable-breakpad', '--disable-component-extensions-with-background-pages',
              '--disable-default-apps', '--disable-sync', '--disable-translate',
              '--metrics-recording-only', '--mute-audio', '--no-first-run',
              '--safebrowsing-disable-auto-update', '--disable-software-rasterizer',
            ];
      const picked = pickRandomProxy();
      currentBrowserProxyConfig = picked ? picked.config : null;
      if (currentBrowserProxyConfig) {
              args.push(`--proxy-server=${currentBrowserProxyConfig.hostPort}`);
              console.log(`[retail-parser] Puppeteer запускається з проксі: ${currentBrowserProxyConfig.hostPort}`);
      }
      const browser = await withTimeout(
              puppeteer.default.launch({ headless: true, args }),
              BROWSER_LAUNCH_TIMEOUT_MS,
              'Puppeteer: запуск браузера перевищив ліміт часу'
            );
      return browser;
}

export async function getBrowser() {
      if (!browserPromise) {
              const thisLaunch = launchBrowser().then((browser) => {
                        browser.on('disconnected', () => {
                                    console.error('[retail-parser] Puppeteer-браузер відключився (crash/kill) — перезапущу на наступному запиті');
                                    if (browserPromise === thisLaunch) browserPromise = null;
                        });
                        return browser;
              });
              browserPromise = thisLaunch;
              thisLaunch.catch((e) => {
                        console.error('[retail-parser] не вдалось запустити Puppeteer-браузер:', e instanceof Error ? e.message : e);
                        if (browserPromise === thisLaunch) browserPromise = null;
              });
      }
      return browserPromise;
}

export async function closeBrowser() {
      if (browserPromise) {
              try {
                        const b = await browserPromise;
                        await b.close();
              } catch {
                        // ігноруємо — можливо, вже мертвий/відключений
              }
              browserPromise = null;
      }
}

const MAX_CONCURRENT_PUPPETEER = 3;
let activePuppeteer = 0;
const puppeteerQueue = [];

function acquirePuppeteerSlot() {
      return new Promise((resolve) => {
              const tryAcquire = () => {
                        if (activePuppeteer < MAX_CONCURRENT_PUPPETEER) {
                                    activePuppeteer++;
                                    resolve();
                        } else {
                                    puppeteerQueue.push(tryAcquire);
                        }
              };
              tryAcquire();
      });
}

function releasePuppeteerSlot() {
      activePuppeteer--;
      const next = puppeteerQueue.shift();
      if (next) next();
}

export async function rawFetch(url, opts = {}) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), opts.timeout ?? FETCH_TIMEOUT_MS);
      const picked = pickRandomProxy();
      try {
              return await fetch(url, {
                        method: opts.method || 'GET',
                        body: opts.body,
                        headers: {
                                    'User-Agent': UA,
                                    'Accept-Language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7',
                                    ...opts.headers,
                        },
                        signal: controller.signal,
                        redirect: opts.redirect || 'follow',
                        ...(picked ? { dispatcher: picked.agent } : {}),
              });
      } finally {
              clearTimeout(t);
      }
}

export function collectCookies(res) {
      let raw = [];
      if (typeof res.headers.getSetCookie === 'function') {
              raw = res.headers.getSetCookie();
      } else {
              const single = res.headers.get('set-cookie');
              if (single) raw = [single];
      }
      return raw.map((c) => c.split(';')[0]).join('; ');
}

export async function fetchHtml(url) {
      const res = await rawFetch(url, {
              headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
}

const PRICE_RE = /(\d[\d\s ]{1,7})\s*(?:₴|грн\.?|uah)/gi;

const CASHBACK_STRIP_RE = /\d[\d\s ]{0,7}\s?(?:₴|грн\.?|uah)\s*(?:кешбек|кэшбек|бонус|cashback)[а-яіїєa-z]*/gi;

export function extractPrices(text) {
      const cleaned = text.replace(CASHBACK_STRIP_RE, ' ');
      const out = [];
      let m;
      PRICE_RE.lastIndex = 0;
      while ((m = PRICE_RE.exec(cleaned))) {
              const n = parseInt(m[1].replace(/[\s ]/g, ''), 10);
              if (n && n > 50 && n < 3_000_000) out.push(n);
      }
      return out;
}

const OUT_OF_STOCK_RE = /немає в наявн|нет в наличии|під замовлення|очікується|out of stock|товар закінчився|тимчасово відсутн/i;

export function buildSearchQuery(product) {
      let base = product.model || product.name;
      const parts = [base];
      if (product.tags?.storage && !base.includes(product.tags.storage)) parts.push(product.tags.storage);
      if (product.tags?.color && !base.toLowerCase().includes(product.tags.color.toLowerCase())) parts.push(product.tags.color);
      let q = parts.join(' ')
        .replace(/\b(EU|DE|DACH|INDIA|US|QLA)\b/gi, '')
        .replace(/\bin-ear\s+headphones?\b/gi, '')
        .replace(/\bheadphones?\b/gi, '')
        .replace(/\bcharging\s+case\b/gi, '')
        .replace(/\bw\/\s*/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return q;
}

export function buildQueryVariants(product) {
      const full = buildSearchQuery(product);
      const words = full.split(' ').filter(Boolean);
      const variants = [full];
      for (let n = words.length - 1; n >= 3; n--) {
              const v = words.slice(0, n).join(' ');
              if (!variants.includes(v)) variants.push(v);
      }
      if (words.length >= 3) {
              const dropFirst = words.slice(1).join(' ');
              if (!variants.includes(dropFirst)) variants.push(dropFirst);
      }
      return variants;
}

function tokenize(s) {
      return (s || '')
        .toLowerCase()
        .replace(/active\s+noise\s+cancellation/g, 'anc')
        .replace(/["'()]/g, ' ')
        .split(/[\s,/]+/)
        .filter(w => w.length > 1 || /\d/.test(w));
}

const ACCESSORY_RE = /^(чохол|чохли|плівка|скло|захисне|кабель|адаптер|зарядн|підставка|тримач|ремінець|ремінці|стрічка|кейс|сумка|бампер|перехідник|заряд[а-яіїєґ]*\s*пристрій|дисковод|накладка|захист)(?![a-zа-яіїєґ'])/i;

const ACCESSORY_FOR_RE = /\bдля\s+(консол[іе]|приставк[иа]|телефон[ау]|смартфон[ау]|ноутбук[ау]|систем[иа]|годинник[ау]|планшет[ау])\b/i;

export function isAccessoryTitle(title) {
      const t = (title || '').trim();
      return ACCESSORY_RE.test(t) || ACCESSORY_FOR_RE.test(t);
}

const COLOR_WORDS = new Set([
      'black', 'white', 'blue', 'red', 'green', 'purple', 'pink', 'silver', 'gold', 'gray', 'grey',
      'graphite', 'titanium', 'obsidian', 'lavender', 'icyblue', 'navy', 'mint', 'cream', 'bronze',
      'beige', 'coral', 'yellow', 'orange', 'rose', 'violet', 'charcoal', 'jetblack', 'fog', 'indigo',
      'lilac', 'graygreen', 'transparent', 'teal', 'sage', 'midnight', 'starlight', 'ultramarine',
    ]);
const LINE_MODIFIERS = new Set([
      'air', 'pro', 'max', 'ultra', 'plus', 'mini', 'se', 'fe', 'lite', 'note', 'fold', 'flip', 'classic', 'active', 'anc',
      'disc', 'digital',
    ]);

export function scoreMatch(query, title) {
      const qTokens = tokenize(query);
      const tTokensArr = tokenize(title);
      const tTokens = new Set(tTokensArr);
      if (qTokens.length === 0) return 0;
      let hit = 0;
      for (const t of qTokens) if (tTokens.has(t)) hit++;
      let score = hit / qTokens.length;

  const qColors = qTokens.filter(t => COLOR_WORDS.has(t));
      const tColors = tTokensArr.filter(t => COLOR_WORDS.has(t));
      if (qColors.length > 0 && tColors.length > 0 && !tColors.some(c => qColors.includes(c))) {
              score *= 0.3;
      }

  const qMods = new Set(qTokens.filter(t => LINE_MODIFIERS.has(t)));
      const tMods = new Set(tTokensArr.filter(t => LINE_MODIFIERS.has(t)));
      let modMismatch = false;
      for (const m of tMods) if (!qMods.has(m)) modMismatch = true;
      for (const m of qMods) if (!tMods.has(m)) modMismatch = true;
      if (modMismatch) score *= 0.3;

  return score;
}

export const MATCH_THRESHOLD = 0.6;

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

                        let $container = $a;
          let priceText = '';
          for (let i = 0; i < 4 && priceText === ''; i++) {
                    $container = $container.parent();
                    if ($container.length === 0) break;
                    const t = $container.text();
                    if (t.length > 1200) break;
                    if (extractPrices(t).length > 0) priceText = t;
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

export async function extractCandidatesPuppeteer(page, opts = {}) {
      const maxCandidates = opts.maxCandidates ?? 400;
      return page.evaluate((maxCandidates) => {
              const PRICE_RE = /(\d[\d\s ]{1,7})\s*(?:₴|грн\.?|uah)/gi;
              const CASHBACK_STRIP_RE = /\d[\d\s ]{0,7}\s?(?:₴|грн\.?|uah)\s*(?:кешбек|кэшбек|бонус|cashback)[а-яіїєa-z]*/gi;
              const OUT_RE = /немає в наявн|нет в наличии|під замовлення|очікується|out of stock|товар закінчився|тимчасово відсутн/i;
              function extractPrices(text) {
                        const cleaned = text.replace(CASHBACK_STRIP_RE, ' ');
                        const out = [];
                        let m; PRICE_RE.lastIndex = 0;
                        while ((m = PRICE_RE.exec(cleaned))) {
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
                                    if (t.length > 1200) break;
                                    if (extractPrices(t).length > 0) priceText = t;
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
      const queryIsAccessory = isAccessoryTitle(query);
      let best = null;
      let bestScore = 0;
      for (const c of candidates) {
              let s = scoreMatch(query, c.title);
              if (!queryIsAccessory && isAccessoryTitle(c.title)) s *= 0.5;
              if (s > bestScore) { bestScore = s; best = c; }
      }
      if (best && bestScore >= MATCH_THRESHOLD) return { ...best, score: bestScore };
      return null;
}

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

export async function withPuppeteerPage(fn) {
      const browser = await getBrowser();
      let page;
      try {
              page = await withTimeout(browser.newPage(), NEW_PAGE_TIMEOUT_MS, 'Puppeteer: newPage() перевищив ліміт часу');
      } catch (e) {
              console.error('[retail-parser] Puppeteer newPage() завис — перезапускаю браузер:', e instanceof Error ? e.message : e);
              try { browser.process()?.kill('SIGKILL'); } catch { /* ігноруємо */ }
              if (browserPromise) browserPromise = null;
              throw e;
      }
      try {
              if (currentBrowserProxyConfig && currentBrowserProxyConfig.username) {
                        await page.authenticate({ username: currentBrowserProxyConfig.username, password: currentBrowserProxyConfig.password });
              }
              await page.setUserAgent(UA);
              await page.setViewport({ width: 1024, height: 720 });
              await page.setRequestInterception(true);
              page.on('request', (req) => {
                        if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) req.abort().catch(() => {});
                        else req.continue().catch(() => {});
              });
              page.setDefaultNavigationTimeout(PUPPETEER_NAV_TIMEOUT_MS);
              return await withTimeout(fn(page), PAGE_WORK_TIMEOUT_MS, 'Puppeteer: перевищено ліміт часу на сторінку');
      } finally {
              await page.close().catch(() => {});
      }
}

async function withPuppeteerPageLimited(fn) {
      await acquirePuppeteerSlot();
      try {
              return await withPuppeteerPage(fn);
      } finally {
              releasePuppeteerSlot();
      }
}

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
                        let prevLen = -1;
                        for (let i = 0; i < 4; i++) {
                                    await new Promise(r => setTimeout(r, 700));
                                    const len = await page.evaluate(() => document.body.innerText.length).catch(() => -1);
                                    if (len === prevLen) break;
                                    prevLen = len;
                        }
                        return true;
              } catch {
                        continue;
              }
      }
      return false;
}

export async function scrapeStore(config, product) {
      const queries = buildQueryVariants(product);
      const now = new Date();
      const updated = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${now.toLocaleDateString('uk-UA')}`;

  let fetchFailed = false;
      if (!config.skipCheerioFetch) {
              for (const query of queries) {
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
                                    console.error(`[retail-parser] ${config.name} fetch-шлях впав: ${e instanceof Error ? e.message : e}`);
                                    fetchFailed = true;
                                    break;
                        }
              }
      }
      void fetchFailed;

  if (config.usePuppeteerFallback !== false) {
          if (config.skipPuppeteerWithoutProxy && !hasProxy()) {
                    return {
                                store: config.name, price: 0, available: false, updated, status: 'error',
                                error: 'Заблоковано за IP хостингу — потрібен проксі (PROXY_URL)',
                    };
          }
          const puppeteerQueries = queries.length > 1 ? [queries[0], queries[queries.length - 1]] : queries;
          try {
                    for (const query of puppeteerQueries) {
                                const result = await withPuppeteerPageLimited(async (page) => {
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
                    }
                    return { store: config.name, price: 0, available: false, updated, status: 'no-product' };
          } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.error(`[retail-parser] ${config.name} puppeteer-шлях впав: ${msg}`);
                    return { store: config.name, price: 0, available: false, updated, status: 'error', error: msg };
          }
  }

  return { store: config.name, price: 0, available: false, updated, status: 'no-product' };
}

export { cheerio };
