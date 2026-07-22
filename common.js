// Спільні утиліти для всіх парсерів роздрібних магазинів.

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
const PAGE_WORK_TIMEOUT_MS = 60000;

let browserPromise = null;

const PUPPETEER_LAUNCH_ARGS = [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-gpu', '--disable-extensions', '--disable-background-networking',
          '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
          '--disable-breakpad', '--disable-component-extensions-with-background-pages',
          '--disable-default-apps', '--disable-sync', '--disable-translate',
          '--metrics-recording-only', '--mute-audio', '--no-first-run',
          '--safebrowsing-disable-auto-update', '--disable-software-rasterizer',
        ];

let stealthApplied = false;
async function getPuppeteerExtra() {
          const { default: puppeteerExtra } = await import('puppeteer-extra');
          if (!stealthApplied) {
                      const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
                      puppeteerExtra.use(StealthPlugin());
                      stealthApplied = true;
          }
          return puppeteerExtra;
}

async function launchBrowser() {
          const puppeteer = await getPuppeteerExtra();
          const browser = await withTimeout(
                      puppeteer.launch({ headless: true, args: PUPPETEER_LAUNCH_ARGS }),
                      BROWSER_LAUNCH_TIMEOUT_MS,
                      'Puppeteer: запуск браузера перевищив ліміт часу'
                    );
          return browser;
}

let proxyBrowserPromise = null;
let proxyBrowserProxyConfig = null;

async function launchProxyBrowser() {
          const picked = pickRandomProxy();
          if (!picked) {
                      throw new Error('Немає доступних проксі в пулі (PROXY_URLS) для проксованого Puppeteer-браузера');
          }
          const puppeteer = await getPuppeteerExtra();
          proxyBrowserProxyConfig = picked.config;
          const browser = await withTimeout(
                      puppeteer.launch({
                                    headless: true,
                                    args: [...PUPPETEER_LAUNCH_ARGS, `--proxy-server=${picked.config.hostPort}`],
                      }),
                      BROWSER_LAUNCH_TIMEOUT_MS,
                      'Puppeteer (проксі): запуск браузера перевищив ліміт часу'
                    );
          return browser;
}

export async function getProxyBrowser() {
          if (!proxyBrowserPromise) {
                      const thisLaunch = launchProxyBrowser().then((browser) => {
                                    browser.on('disconnected', () => {
                                                    console.error('[retail-parser] Puppeteer-браузер (проксі) відключився — перезапущу на наступному запиті (з новим випадковим проксі)');
                                                    if (proxyBrowserPromise === thisLaunch) proxyBrowserPromise = null;
                                    });
                                    return browser;
                      });
                      proxyBrowserPromise = thisLaunch;
                      thisLaunch.catch((e) => {
                                    console.error('[retail-parser] не вдалось запустити Puppeteer-браузер (проксі):', e instanceof Error ? e.message : e);
                                    if (proxyBrowserPromise === thisLaunch) proxyBrowserPromise = null;
                      });
          }
          return proxyBrowserPromise;
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
                      }
                      browserPromise = null;
          }
          if (proxyBrowserPromise) {
                      try {
                                    const b = await proxyBrowserPromise;
                                    await b.close();
                      } catch {
                      }
                      proxyBrowserPromise = null;
          }
}

const MAX_CONCURRENT_PUPPETEER = 6;
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
          const picked = opts.useProxy ? pickRandomProxy() : null;
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

export async function fetchHtml(url, opts = {}) {
          const res = await rawFetch(url, {
                      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
                      useProxy: opts.useProxy,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
}

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-aurj.onrender.com';
const FLARESOLVERR_TIMEOUT_MS = 60000;

// ПРИЧИНА ЗНАЙДЕНА (14.07, п'ята спроба, підтверджено логами самого
// FlareSolverr-сервісу): "HTML ~250KB з 0 посилань" і подальші HTTP 502
// НЕ пов'язані з проксі (перевірено — однакова поведінка і з проксі, і
// без, через FLARESOLVERR_NO_PROXY). Реальна причина: коли iStore й МТА
// скрапляться паралельно, FlareSolverr одночасно отримує 2 запити — і
// оскільки сам він піднімає ПОВНОЦІННИЙ headless Chrome на кожен запит,
// 2 одночасних Chrome-процеси перевищують пам'ять starter-тарифу Render
// — сервіс падає по OOM і Render автоматично перезапускає його (в логах
// FlareSolverr видно "Instance restarted" одразу після двох "Incoming
// request" підряд). Той самий клас багу, що й із Puppeteer у самому
// crm-retail-parser (звідси MAX_CONCURRENT_PUPPETEER вище). РІШЕННЯ:
// серіалізуємо виклики через простий мьютекс-ланцюжок — незалежно від
// того, скільки магазинів скрапляться паралельно в server.js, до
// FlareSolverr одночасно піде максимум ОДИН запит.
let flareSolverrChainTail = Promise.resolve();
function withFlareSolverrLock(fn) {
          const run = flareSolverrChainTail.then(fn, fn);
          flareSolverrChainTail = run.then(() => undefined, () => undefined);
          return run;
}

async function fetchViaFlareSolverr(url, opts = {}) {
          return withFlareSolverrLock(() => fetchViaFlareSolverrInner(url, opts));
}

async function fetchViaFlareSolverrInner(url, opts = {}) {
          const picked = opts.useProxy ? pickRandomProxy() : null;
          const body = {
                      cmd: 'request.get',
                      url,
                      maxTimeout: FLARESOLVERR_TIMEOUT_MS,
          };
          if (picked) {
                      body.proxy = { url: picked.config.href };
          }
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), FLARESOLVERR_TIMEOUT_MS + 5000);
          try {
                      const res = await fetch(`${FLARESOLVERR_URL}/v1`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(body),
                                    signal: controller.signal,
                      });
                      if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`);
                      const data = await res.json();
                      if (data.status !== 'ok' || !data.solution?.response) {
                                    throw new Error(`FlareSolverr відповів без розв'язку: ${data.message || data.status}`);
                      }
                      return data.solution.response;
          } finally {
                      clearTimeout(t);
          }
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

const ACCESSORY_RE = /^(чохол|чохли|плівка|скло|захисне|кабель|адаптер|зарядн|підставка|тримач|ремінець|ремінці|стрічка|кейс|сумка|бампер|перехідник|заряд[а-яіїєґ]*\s*пристрій|дисковод|накладка|захист|наклейка|наліпка|стікер|стикер|скін|скин|вініл[а-яіїєґ]*)(?![a-zа-яіїєґ'])/i;
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
              const text = $a.text().replace(/\s+/g, ' ').trim() || ($a.find('img[alt]').first().attr('alt') || '').trim();
              if (text.length < 6 || text.length > 160) return;
              const href = $a.attr('href');
              if (!href) return;

                        let $container = $a;
              let priceText = '';
              for (let i = 0; i < 4 && priceText === ''; i++) {
                            $container = $container.parent();
                            if ($container.length === 0) break;
                            const t = $container.text();
                            if (t.length > 3000) break;
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
                                                    if (t.length > 3000) break;
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

export async function withPuppeteerPage(fn, opts = {}) {
          const browser = opts.useProxy ? await getProxyBrowser() : await getBrowser();
          let page;
          try {
                      page = await withTimeout(browser.newPage(), NEW_PAGE_TIMEOUT_MS, 'Puppeteer: newPage() перевищив ліміт часу');
          } catch (e) {
                      console.error('[retail-parser] Puppeteer newPage() завис — перезапускаю браузер:', e instanceof Error ? e.message : e);
                      try { browser.process()?.kill('SIGKILL'); } catch { /* ігноруємо */ }
                      if (opts.useProxy) { if (proxyBrowserPromise) proxyBrowserPromise = null; }
                      else { if (browserPromise) browserPromise = null; }
                      throw e;
          }
          try {
                      if (opts.useProxy && proxyBrowserProxyConfig && proxyBrowserProxyConfig.username) {
                                    await page.authenticate({ username: proxyBrowserProxyConfig.username, password: proxyBrowserProxyConfig.password });
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

async function withPuppeteerPageLimited(fn, opts = {}) {
          await acquirePuppeteerSlot();
          try {
                      return await withPuppeteerPage(fn, opts);
          } finally {
                      releasePuppeteerSlot();
          }
}

async function waitForCloudflareChallenge(page, timeoutMs = 10000) {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
                      const isChallenge = await page.evaluate(() => {
                                    const t = document.title || '';
                                    return /just a moment|момент|checking your browser|перевірка безпеки/i.test(t)
                                      || !!document.querySelector('#challenge-running, .cf-turnstile, #cf-challenge-running');
                      }).catch(() => false);
                      if (!isChallenge) return true;
                      await new Promise(r => setTimeout(r, 700));
          }
          return false;
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

const SEARCH_TOGGLE_SELECTORS = [
          '.search_ico',
          '[class*="search-toggle" i]',
          '[class*="search_toggle" i]',
          'button[aria-label*="пошук" i]',
          'button[aria-label*="search" i]',
          'a[aria-label*="пошук" i]',
          'a[aria-label*="search" i]',
        ];

async function findVisibleSearchInput(page) {
          for (const sel of SEARCH_INPUT_SELECTORS) {
                      const el = await page.$(sel);
                      if (!el) continue;
                      const visible = await el.evaluate(node => {
                                    const r = node.getBoundingClientRect();
                                    const style = getComputedStyle(node);
                                    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                      }).catch(() => false);
                      if (visible) return el;
          }
          return null;
}

async function waitForContentStabilization(page, iterations = 6, intervalMs = 700) {
          let prevLen = -1;
          for (let i = 0; i < iterations; i++) {
                      await new Promise(r => setTimeout(r, intervalMs));
                      const len = await page.evaluate(() => document.body.innerText.length).catch(() => -1);
                      if (len === prevLen) break;
                      prevLen = len;
          }
}

export async function typeIntoSiteSearch(page, query) {
          await waitForCloudflareChallenge(page);
          let el = await findVisibleSearchInput(page);
          if (!el) {
                      for (const sel of SEARCH_TOGGLE_SELECTORS) {
                                    const toggle = await page.$(sel);
                                    if (!toggle) continue;
                                    try {
                                                    await toggle.click();
                                                    await new Promise(r => setTimeout(r, 600));
                                                    el = await findVisibleSearchInput(page);
                                                    if (el) break;
                                    } catch {
                                                    continue;
                                    }
                      }
          }
          if (el) {
                      try {
                                    await el.click({ clickCount: 3 });
                                    await el.type(query, { delay: 20 });
                                    await Promise.all([
                                                    page.keyboard.press('Enter'),
                                                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: PUPPETEER_NAV_TIMEOUT_MS }).catch(() => null),
                                                  ]);
                                    await waitForContentStabilization(page);
                                    return true;
                      } catch {
                                    return false;
                      }
          }
          return false;
}

export async function scrapeStore(config, product) {
          const queries = buildQueryVariants(product);
          const now = new Date();
          const updated = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${now.toLocaleDateString('uk-UA')}`;

  let fetchFailed = false;
          let fetchFailReason = '';
          if (!config.skipCheerioFetch) {
                      for (const query of queries) {
                                    try {
                                                    const url = config.searchUrl(query);
                                                    const html = await fetchHtml(url, { useProxy: !!config.useProxy });
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
                                                    fetchFailReason = e instanceof Error ? e.message : String(e);
                                                    console.error(`[retail-parser] ${config.name} fetch-шлях впав: ${fetchFailReason}`);
                                                    fetchFailed = true;
                                                    break;
                                    }
                      }
          }

  if (config.useFlareSolverr) {
              for (const query of queries.slice(0, 2)) {
                            try {
                                            const url = config.searchUrl(query);
                                            const useProxyForFlareSolverr = !!config.useProxy && process.env.FLARESOLVERR_NO_PROXY !== 'true';
                                            const html = await fetchViaFlareSolverr(url, { useProxy: useProxyForFlareSolverr });
                                            const $ = cheerio.load(html);
                                            const candidates = extractCandidatesCheerio($, url);
                                            console.log(`[retail-parser][debug] ${config.name} (FlareSolverr, proxy=${useProxyForFlareSolverr}) query="${query}" htmlLen=${html.length} htmlTitle="${($('title').text() || '').replace(/\s+/g, ' ').trim().slice(0, 120)}" anchors=${$('a[href]').length} candidates=${candidates.length}${candidates.length ? ' top=' + JSON.stringify(candidates.slice(0, 5).map(c => ({ t: c.title, p: c.price }))) : ''}`);
                                            const best = pickBest(candidates, query);
                                            if (best) {
                                                              return {
                                                                                  store: config.name, price: best.price, available: best.available,
                                                                                  updated, status: 'ok', url: best.url, matchedTitle: best.title,
                                                              };
                                            }
                            } catch (e) {
                                            console.error(`[retail-parser] ${config.name} FlareSolverr-шлях впав: ${e instanceof Error ? e.message : e}`);
                                            break;
                            }
              }
  }

  if (config.usePuppeteerFallback !== false) {
              if (config.skipPuppeteerWithoutProxy && !hasProxy()) {
                            return {
                                            store: config.name, price: 0, available: false, updated, status: 'error',
                                            error: 'Заблоковано за IP хостингу — потрібен проксі (PROXY_URL)',
                            };
              }
              const puppeteerQueries = [queries[0]];
              try {
                            for (const query of puppeteerQueries) {
                                            const result = await withPuppeteerPageLimited(async (page) => {
                                                              let cfCleared = null;
                                                              if (config.puppeteerUseSearchUrl) {
                                                                                  await page.goto(config.searchUrl(query), { waitUntil: 'domcontentloaded' });
                                                                                  cfCleared = await waitForCloudflareChallenge(page, 20000);
                                                                                  await waitForContentStabilization(page);
                                                              } else {
                                                                                  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
                                                                                  const typed = await typeIntoSiteSearch(page, query);
                                                                                  if (!typed) return null;
                                                              }
                                                              const candidates = await extractCandidatesPuppeteer(page);
                                                              const debugInfo = await page.evaluate(() => ({
                                                                                  title: document.title,
                                                                                  url: location.href,
                                                                                  len: document.body ? document.body.innerText.length : -1,
                                                                                  anchors: document.querySelectorAll('a[href]').length,
                                                              })).catch(() => null);
                                                              console.log(`[retail-parser][debug] ${config.name} query="${query}" cfCleared=${cfCleared} pageTitle="${debugInfo?.title}" pageUrl=${debugInfo?.url} textLen=${debugInfo?.len} anchors=${debugInfo?.anchors} candidates=${candidates.length}${candidates.length ? ' top=' + JSON.stringify(candidates.slice(0, 5).map(c => ({ t: c.title, p: c.price }))) : ''}`);
                                                              return pickBest(candidates, query);
                                            }, { useProxy: !!config.useProxy });
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

  if (fetchFailed) {
              return { store: config.name, price: 0, available: false, updated, status: 'error', error: fetchFailReason };
  }
          return { store: config.name, price: 0, available: false, updated, status: 'no-product' };
}

export { cheerio };
