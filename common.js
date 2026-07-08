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

// ---------- Проксі (опційно) ----------
// Щоб уникнути блокування за IP датацентру (МТА, iStore повертають 403
// з IP Render/AWS/GCP тощо) — задай в змінних середовища PROXY_URL, напр.:
//   PROXY_URL=http://login:password\@ua-proxy-host:port
// Без цієї змінної все працює як раніше (прямі запити з IP сервера).
function getProxyConfig() {
  const url = process.env.PROXY_URL;
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      href: url,
      server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`,
      hostPort: `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch {
    console.error('[retail-parser] PROXY_URL некоректний, ігнорую:', url);
    return null;
  }
}

const proxyConfig = getProxyConfig();
let proxyAgent = null;
if (proxyConfig) {
  proxyAgent = new ProxyAgent(proxyConfig.href);
  console.log(`[retail-parser] проксі увімкнено: ${proxyConfig.hostPort}`);
}

export function hasProxy() {
  return !!proxyConfig;
}

let browserPromise = null;
export async function getBrowser() {
  if (!browserPromise) {
    const puppeteer = await import('puppeteer');
    // Мінімізуємо пам'ять Chrome — сервер на 512MB-1GB RAM падав по OOM
    // при рендері важких сторінок (перевірено в проді: Render логи
    // показували "Instance restarted" кожні кілька хвилин під час
    // Jabko/Yablyka скрапу). Ці прапори вимикають усе непотрібне для
    // headless-парсингу (GPU, розширення, фонову синхронізацію тощо).
    const args = [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-breakpad', '--disable-component-extensions-with-background-pages',
      '--disable-default-apps', '--disable-sync', '--disable-translate',
      '--metrics-recording-only', '--mute-audio', '--no-first-run',
      '--safebrowsing-disable-auto-update', '--disable-software-rasterizer',
    ];
    if (proxyConfig) args.push(`--proxy-server=${proxyConfig.hostPort}`);
    browserPromise = puppeteer.default.launch({ headless: true, args });
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

// ---------- Обмеження одночасних Puppeteer-сторінок ----------
// Render тепер на тарифі Standard (2GB RAM) — можна дозволити більше
// одночасних сторінок, ніж на 512MB (де все падало по OOM). 3 — з запасом,
// щоб і швидше скрапилось, і пам'яті вистачало з надлишком.
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

// ---------- Низькорівневий fetch (для кастомної логіки магазину) ----------
// На відміну від fetchHtml — повертає сирий Response (щоб можна було читати
// заголовки/куки), підтримує довільний метод/тіло/заголовки. Використовується
// магазинами з нестандартним пошуком (напр. GRO: cookie+CSRF, JustBuy: JSON API).
export async function rawFetch(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeout ?? FETCH_TIMEOUT_MS);
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
      ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
    });
  } finally {
    clearTimeout(t);
  }
}

// Витягує "ім'я=значення" з усіх Set-Cookie заголовків відповіді, готове для
// підстановки у Cookie-заголовок наступного запиту (сесія без cookie-jar).
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

// ---------- Ціни ----------

// Знаходить усі "грн-подібні" числа у шматку тексту: "65 999 ₴", "65999грн", "65 999 UAH"
const PRICE_RE = /(\d[\d\s ]{1,7})\s*(?:₴|грн\.?|uah)/gi;

// "111 ₴ кешбеку" поруч із реальною ціною — Math.min() нижче раніше вибирав
// саме кешбек/бонус як "найменшу ціну" (перевірено на практиці — Yablyka).
// Прибираємо такі згадки з тексту ДО пошуку цін.
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
    // Постачальницькі "пакувальні" фрази (форм-фактор/комплектація) —
    // описують не сам товар, а його упаковку, і практично ніколи не
    // з'являються в назвах магазинів. Перевірено на практиці: "Apple
    // AirPods 4 USB-C Charging Case w/ ANC In-Ear Headphones White" не
    // знаходився НІДЕ (JustBuy/GRO — "не знайдено", хоча товар в
    // наявності), бо ці 4 зайвих слова різко занижували частку збігу
    // токенів. Прибираємо їх ДО побудови запиту.
    .replace(/\bin-ear\s+headphones?\b/gi, '')
    .replace(/\bheadphones?\b/gi, '')
    .replace(/\bcharging\s+case\b/gi, '')
    .replace(/\bw\/\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q;
}

// Деякі магазини мають "крихкий" пошук — не наш ratio-скоринг, а сам
// пошуковий рушник сайту повертає 0 кандидатів, якщо запит задовгий чи
// містить занадто багато уточнень. Перевірено на практиці (GRO,
// grokholsky.com): "Apple AirPods 4 USB-C ANC White" -> 0 результатів,
// "Apple AirPods 4" -> 2 результати. Тому пробуємо запит від
// найповнішого до дедалі коротшого (відкидаючи слова з кінця — туди
// зазвичай потрапляють уточнення на кшталт кольору), лишаючи щонайменше
// 3 слова (як правило бренд + лінійка + номер моделі).
export function buildQueryVariants(product) {
  const full = buildSearchQuery(product);
  const words = full.split(' ').filter(Boolean);
  const variants = [full];
  for (let n = words.length - 1; n >= 3; n--) {
    const v = words.slice(0, n).join(' ');
    if (!variants.includes(v)) variants.push(v);
  }
  // Обрізаємо ще й з ПОЧАТКУ рядка (не лише з кінця, як вище) — виявлено
  // на практиці на прикладі "Ps5 PlayStation VR2": "Ps5" тут у назві з
  // каталогу — це щось на кшталт категорійного префіксу (консоль/платформа),
  // а не частина реальної назви товару на сайті магазину (GRO продає його
  // просто як "Sony PlayStation VR2..."). Пошук GRO на "Ps5 PlayStation
  // VR2" повертає 0 результатів (і жоден із варіантів вище цього не
  // виправляє, бо вони лише коротшають з кінця й перше слово лишається),
  // а на "PlayStation VR2" (без "Ps5") — знаходить одразу. Пробуємо
  // відкинути перше слово як окремий, останній за пріоритетом варіант.
  if (words.length >= 3) {
    const dropFirst = words.slice(1).join(' ');
    if (!variants.includes(dropFirst)) variants.push(dropFirst);
  }
  return variants;
}

function tokenize(s) {
  // w.length > 1 відсіює однобуквений "сміттєвий" залишок пунктуації, АЛЕ
  // так само зрізав однозначні числа-розрізнювачі моделі ("AirPods 4",
  // "iPhone 5s" -> токен "4"/"5s" довжиною 1/2 — "4" губився повністю).
  // Це і призводило до "AirPods 4 не знайдено": запит лишався тільки з
  // ['apple','airpods'], а на сайтах, де в назві товару немає слова
  // "Apple" (напр. Yablyka), збіг падав нижче порогу впевненості. Тому
  // однозначні ЦИФРИ лишаємо навіть при довжині 1.
  return (s || '')
    .toLowerCase()
    // "Active Noise Cancellation" (магазини пишуть повністю) vs "ANC"
    // (постачальник пише скорочено в каталозі) — без нормалізації це два
    // геть різних набори токенів, і жодна сторона не бачить збігу за цією
    // єдиною ознакою, що відрізняє звичайні AirPods 4 від версії з ANC.
    .replace(/active\s+noise\s+cancellation/g, 'anc')
    .replace(/["'()]/g, ' ')
    .split(/[\s,/]+/)
    .filter(w => w.length > 1 || /\d/.test(w));
}

// Слова-маркери аксесуарів — товар з такою назвою (чохол/плівка/кабель для
// X) часто набирає такий самий token-збіг, як і сам товар X (усі слова
// запиту присутні), і без цієї перевірки міг переважити справжній товар
// (перевірено на практиці: "Чохли для AirPods Pro 3" замість самих
// навушників). Занижуємо такі кандидати, якщо сам запит не про аксесуар.
// ВАЖЛИВО: тут навмисно НЕ використовуємо \b в кінці — JS-регулярки
// вважають "словом" лише ASCII-символи (\w = [a-zA-Z0-9_]), тому \b
// НІКОЛИ не спрацьовує одразу після кириличної літери (немає переходу
// "слово → не-слово", бо кирилиця сама вважається "не-словом"). Через це
// стара версія з \b ніколи не матчила жодного кириличного "Чохол ..." —
// перевірка аксесуарів була фактично вимкнена. Замість \b — явний
// negative lookahead: наступний символ не повинен бути літерою.
const ACCESSORY_RE = /^(чохол|чохли|плівка|скло|захисне|кабель|адаптер|зарядн|підставка|тримач|ремінець|ремінці|стрічка|кейс|сумка|бампер|перехідник|заряд[а-яіїєґ]*\s*пристрій)(?![a-zа-яіїєґ'])/i;

export function isAccessoryTitle(title) {
  return ACCESSORY_RE.test((title || '').trim());
}

// Кольори та "лінійки" моделей — за ними товар легко переплутати з
// сусіднім (iPad проти iPad Air, Silver проти Space Gray), а звичайний
// підрахунок збігу токенів цього не бачить: зайві слова в назві кандидата
// (яких немає в запиті) взагалі не штрафуються. Звідси баг: "iPad 11
// Silver" впевнено матчився на "iPad Air 11 ... Space Gray", бо решта
// слів співпала, а "Air"/"Space Gray" просто ігнорувались.
const COLOR_WORDS = new Set([
  'black', 'white', 'blue', 'red', 'green', 'purple', 'pink', 'silver', 'gold', 'gray', 'grey',
  'graphite', 'titanium', 'obsidian', 'lavender', 'icyblue', 'navy', 'mint', 'cream', 'bronze',
  'beige', 'coral', 'yellow', 'orange', 'rose', 'violet', 'charcoal', 'jetblack', 'fog', 'indigo',
  'lilac', 'graygreen', 'transparent', 'teal', 'sage', 'midnight', 'starlight', 'ultramarine',
]);
const LINE_MODIFIERS = new Set([
  'air', 'pro', 'max', 'ultra', 'plus', 'mini', 'se', 'fe', 'lite', 'note', 'fold', 'flip', 'classic', 'active', 'anc',
]);

// Проста оцінка збігу: частка токенів запиту, які знайшлись у назві
// кандидата, з штрафом за конфлікт кольору чи "лінійки" моделі (Air/Pro/Max/...).
export function scoreMatch(query, title) {
  const qTokens = tokenize(query);
  const tTokensArr = tokenize(title);
  const tTokens = new Set(tTokensArr);
  if (qTokens.length === 0) return 0;
  let hit = 0;
  for (const t of qTokens) if (tTokens.has(t)) hit++;
  let score = hit / qTokens.length;

  // Конфлікт кольору: у назві кандидата є ІНШИЙ впізнаваний колір, якого
  // немає в запиті — майже завжди означає інший варіант товару.
  const qColors = qTokens.filter(t => COLOR_WORDS.has(t));
  const tColors = tTokensArr.filter(t => COLOR_WORDS.has(t));
  if (qColors.length > 0 && tColors.length > 0 && !tColors.some(c => qColors.includes(c))) {
    score *= 0.3;
  }

  // Конфлікт лінійки моделі: Air/Pro/Max/... присутній лише з одного боку —
  // це, як правило, інша модель (напр. iPad проти iPad Air).
  const qMods = new Set(qTokens.filter(t => LINE_MODIFIERS.has(t)));
  const tMods = new Set(tTokensArr.filter(t => LINE_MODIFIERS.has(t)));
  let modMismatch = false;
  for (const m of tMods) if (!qMods.has(m)) modMismatch = true;
  for (const m of qMods) if (!tMods.has(m)) modMismatch = true;
  if (modMismatch) score *= 0.3;

  return score;
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
    // Обмежуємо довжину тексту контейнера (1200 симв.) — інакше на
    // компактних HTML-фрагментах (напр. AJAX-відповідь пошуку) можна
    // "проскочити" на рівень, що обгортає весь список товарів, і підхопити
    // ціну зовсім іншого, не пов'язаного товару (перевірено на практиці —
    // GRO: рівень "картки" ~500 симв., рівень "усього списку" вже 4000+).
    // ВАЖЛИВО: перевіряємо наявність ціни через extractPrices() (з
    // відсіюванням кешбеку), а не сирий PRICE_RE.test() — інакше
    // контейнер, де видно ЛИШЕ суму кешбеку ("238 ₴ кешбек"), а справжня
    // ціна ще не потрапила у виділений фрагмент/не відрендерилась,
    // помилково вважається "ціну знайдено", і Math.min() нижче забирає
    // кешбек замість реальної ціни (перевірено на практиці — Yablyka,
    // Garmin Instinct 3: кешбек 238 ₴ замість ціни 23 816 ₴).
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

// ---------- Генерик-екстрактор кандидатів у живому DOM (Puppeteer page) ----------
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
      // Так само, як у cheerio-варіанті: перевіряємо через extractPrices()
      // (кешбек відсіяно), а не сирий PRICE_RE.test() — інакше контейнер
      // з видимою лише сумою кешбеку хибно "проходить" перевірку.
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
    // Якщо запит НЕ про аксесуар, а кандидат виглядає як аксесуар (чохол,
    // плівка тощо) — занижуємо його бал, щоб справжній товар (за рівного
    // token-збігу) мав перевагу. Без цього "Чохли для X" легко переграє X.
    if (!queryIsAccessory && isAccessoryTitle(c.title)) s *= 0.5;
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (best && bestScore >= MATCH_THRESHOLD) return { ...best, score: bestScore };
  return null;
}

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

export async function withPuppeteerPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    if (proxyConfig && proxyConfig.username) {
      await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }
    await page.setUserAgent(UA);
    // Менший viewport + блокування картинок/шрифтів/стилів — нам потрібен
    // лише текст (назва товару + ціна) з відрендереної сторінки, не її
    // вигляд. Це суттєво знижує пам'ять на сторінку (перевірено: саме
    // рендер важких сторінок з картинками валив процес по OOM на Render).
    await page.setViewport({ width: 1024, height: 720 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });
    page.setDefaultNavigationTimeout(PUPPETEER_NAV_TIMEOUT_MS);
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// Те саме, але з обмеженням кількості одночасних сторінок (див.
// MAX_CONCURRENT_PUPPETEER вище) — використовується в scrapeStore, коли
// кілька магазинів скрапляться паралельно (Promise.allSettled у server.js).
async function withPuppeteerPageLimited(fn) {
  await acquirePuppeteerSlot();
  try {
    return await withPuppeteerPage(fn);
  } finally {
    releasePuppeteerSlot();
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
      // Дочікуємось стабілізації контенту сторінки замість фіксованої
      // паузи — на сайтах з поступовим (streaming/RSC) рендером видачі
      // (перевірено на практиці: Yablyka) фіксовані 1200мс не завжди
      // вистачало: бейдж кешбеку вже встигав відрендеритись, а сам блок
      // ціни — ще ні, і парсер хапав суму кешбеку замість ціни. Порівнюємо
      // довжину видимого тексту сторінки у 2 заміри — якщо однакова,
      // вважаємо, що дорендер завершився.
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

// ---------- Оркестратор одного магазину ----------
// config:
//   name                     — назва магазину (як у RetailStore.store)
//   baseUrl                  — головна сторінка (для fallback через Puppeteer)
//   searchUrl(q)              — функція, що будує URL сторінки видачі пошуку (пробуємо plain fetch)
//   usePuppeteerFallback      — чи пробувати headless-браузер, якщо fetch не дав збігу
//   skipPuppeteerWithoutProxy — не пробувати Puppeteer, якщо PROXY_URL не задано
//                                (для магазинів, які блокують за IP датацентру —
//                                Puppeteer з того ж IP теж буде заблоковано,
//                                тож спроба лише марно вантажить сервер)
//
// Повертає { store, price, available, updated, status, url?, matchedTitle? }
export async function scrapeStore(config, product) {
  // Пробуємо кілька варіантів запиту (повний -> дедалі коротший) — деякі
  // сайти мають крихкий пошук, що повертає 0 кандидатів на задовгий
  // запит (перевірено на практиці, GRO). Fetch-крок дешевий, тож пробуємо
  // всі варіанти; Puppeteer — важкий, тож там лише повний і найкоротший.
  const queries = buildQueryVariants(product);
  const now = new Date();
  const updated = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${now.toLocaleDateString('uk-UA')}`;

  // 1) швидкий шлях — plain fetch + cheerio
  // ВАЖЛИВО: для магазинів зі config.skipCheerioFetch=true цей крок
  // повністю пропускаємо. Причина (виявлено на прикладі Yablyka/ya.ua):
  // сайт — Next.js застосунок зі стрімінговим SSR (React Server
  // Components). Сирий HTML, який бачить plain fetch (без виконання JS),
  // це лише початкова "оболонка" сторінки — на ній вже може бути видно
  // суму кешбеку, але фінальна ціна довантажується/дорендерюється пізніше
  // через стрімінг і в статичному HTML її просто немає. Через це
  // cheerio-шлях знаходив "збіг" і одразу повертав його — з ціною кешбеку
  // (напр. 238₴) замість реальної (23 816₴) — і Puppeteer-фолбек нижче
  // взагалі не встигав спрацювати, бо ми виходили з функції раніше.
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
        break; // сама сторінка/мережа впала — коротші запити цього не виправлять
      }
    }
  }
  void fetchFailed;

  // 2) fallback — headless-браузер із набором тексту у пошук сайту
  if (config.usePuppeteerFallback !== false) {
    if (config.skipPuppeteerWithoutProxy && !hasProxy()) {
      return {
        store: config.name, price: 0, available: false, updated, status: 'error',
        error: 'Заблоковано за IP хостингу — потрібен проксі (PROXY_URL)',
      };
    }
    // Не мультиплікуємо важкі Puppeteer-спроби на всі варіанти запиту —
    // лише повний і найкоротший (base), щоб не роздувати час скрапу.
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
