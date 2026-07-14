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

// БАГ (знайдено користувачем): "парсер годину висить на одній позиції" +
// "ручне оновлення конкретного товару не працює" — обидва симптоми мають
// один корінь. getBrowser() нижче кешував Promise запуску Chrome НАЗАВЖДИ:
// якщо сам процес Chrome падав/вбивався (напр. через пам'ять при появі
// нових товарів) або зависав (жива волокна CDP, але без відповіді),
// browserPromise лишався тим самим "мертвим" об'єктом — і УСІ наступні
// спроби відкрити сторінку (нічний крон, автопрогрів, ручна кнопка
// "Оновити ціни") чекали на нього назавжди, без жодного тайм-ауту. Один
// зіпсований запуск браузера "вимикав" Puppeteer для всього сервера аж до
// ручного рестарту на Render. Нижче — 2 незалежні запобіжники:
// 1. getBrowser() скидає кеш і дозволяє повторний запуск, якщо запуск
// провалився АБО вже запущений браузер відключився (подія 'disconnected').
// 2. withPuppeteerPage() обгортає newPage()/роботу зі сторінкою у жорсткий
// тайм-аут — якщо перевищено, примусово вбиває процес браузера і
// скидає кеш, замість того щоб чекати відповіді, якої вже не буде.
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
// fetch-запит (rawFetch), що явно попросив проксі (opts.useProxy),
// випадково бере ОДИН проксі з пулу, тож якщо конкретний IP забанений —
// наступний запит піде вже з іншого.
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
// 45с -> 60с (14.07): "Стан парсера" показав, що більшість помилок
// Jabko/Yablyka — саме "перевищено ліміт часу на сторінку" (цей тайм-аут),
// а не мережеві/навігаційні збої з окремими повідомленнями. Тобто це
// справді повільний рендер важких сторінок, який просто не встигає в 45с,
// а не зависання. 15 зайвих секунд на маржинальні випадки — прийнятний
// компроміс: чергу тримає MAX_CONCURRENT_PUPPETEER (6 слотів), тож один
// повільніший товар не блокує решту.
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

// Puppeteer-extra + stealth-плагін (14.07, третя діагностична спроба) —
// розширене логування показало ДВІ узгоджені ознаки автоматизованого
// детектування бота, а не просто повільний рендер/проксі-таймінг:
// 1. МТА: cfCleared=false навіть після підняття тайм-ауту 10с -> 20с,
//    pageTitle досі "Just a moment..." — Cloudflare Managed Challenge на
//    практиці НЕ є простим таймером-редіректом (той минає за ~1-2с у
//    реальному браузері), а справжньою перевіркою автоматизації (звичайний
//    headless Puppeteer має navigator.webdriver=true та інші ознаки, які
//    Cloudflare явно детектує) — тому чекати довше марно, виклик у
//    звичайному headless-режимі просто ніколи не мине.
// 2. iStore: candidates=2 (лише "N відгуків"/"Залишити відгук" посилання,
//    textLen=5272, anchors=298) — при РУЧНІЙ перевірці (звичайний Chrome,
//    той самий 1024x720 viewport, той самий /ua/find/ URL) сторінка чесно
//    віддає 4 кандидати, включно зі справжніми назвами товару. Bitrix
//    (iStore) очевидно теж має якусь легку антибот-перевірку, що
//    вибірково приховує "цінні" для скрапера елементи (посилання на
//    товар), а не блокує сторінку повністю (403) — узгоджується з тим,
//    що cheerio/fetch-шлях для iStore ще раніше давав 403, а Puppeteer
//    без stealth — лише часткову деградацію.
// puppeteer-extra-plugin-stealth підмінює/приховує typові ознаки
// автоматизації (navigator.webdriver, chrome.runtime, WebGL vendor,
// permissions API тощо) — стандартний, широко використовуваний спосіб
// проходити саме такі перевірки. Застосовуємо для ОБОХ браузерів
// (звичайного й проксованого) — Jabko/Yablyka не мають антибот-захисту,
// тож для них це просто без ефекту, але й не зашкодить.
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
              // Мінімізуємо пам'ять Chrome — сервер на 512MB-1GB RAM падав по OOM
  // при рендері важких сторінок (перевірено в проді: Render логи
  // показували "Instance restarted" кожні кілька хвилин під час
  // Jabko/Yablyka скрапу). Ці прапори вимикають усе непотрібне для
  // headless-парсингу (GPU, розширення, фонову синхронізацію тощо).
  //
  // ІНЦИДЕНТ (13.07): браузер раніше завжди запускався з випадковим
  // проксі з пулу, якщо пул був заданий (PROXY_URLS). Коли весь пул
  // Webshare тимчасово став недоступний (ERR_TUNNEL_CONNECTION_FAILED
  // на кожному з 10 IP), це миттєво поклало Jabko й Yablyka — хоча ЖОДЕН
  // з них проксі взагалі не потребує (обидва не блокують за IP
  // датацентру, їм просто важко/повільно рендериться сторінка).
  // Цей browserPromise — СПІЛЬНИЙ інстанс БЕЗ проксі, використовується
  // лише Jabko/Yablyka. iStore/МТА (14.07, після переходу на резидентний
  // проксі) отримали ОКРЕМИЙ інстанс — getProxyBrowser() нижче — щоб
  // повторення інциденту 13.07 (падіння проксі) знову не зачепило
  // Jabko/Yablyka.
  const browser = await withTimeout(
                  puppeteer.launch({ headless: true, args: PUPPETEER_LAUNCH_ARGS }),
                  BROWSER_LAUNCH_TIMEOUT_MS,
                  'Puppeteer: запуск браузера перевищив ліміт часу'
                );
              return browser;
}

// ---------- Окремий, проксований інстанс браузера (iStore/МТА, 14.07) ----------
// НАВІЩО: голий fetch навіть через робочий резидентний проксі Webshare
// (Static Residential, підтверджено — реальні ISP-адреси США/Франції/
// Німеччини/Канади, не датацентр) усе одно отримує HTTP 403 від iStore.ua
// і mta.ua. Висновок: ці сайти звіряють не лише репутацію IP, а й
// "відбиток" самого запиту (TLS/HTTP-заголовки) — простий fetch з Node.js
// такого відбитка не має, а справжній headless Chrome (Puppeteer) — має.
// Пробуємо провести Puppeteer через той самий резидентний проксі.
//
// ІЗОЛЯЦІЯ: це ПОВНІСТЮ окремий інстанс браузера (окремий процес Chrome,
// окремий browserPromise) від getBrowser() вище — навмисно, щоб знову не
// повторити інцидент 13.07: якщо цей проксований браузер впаде/зависне
// (проксі відвалиться, IP забанять тощо), це torkнe лише iStore/МТА,
// а Jabko/Yablyka на звичайному browserPromise продовжать працювати як
// і раніше.
let proxyBrowserPromise = null;
// Проксі (host:port + креденшли), з яким запущено ПОТОЧНИЙ проксований
// інстанс — потрібен для page.authenticate() на кожній новій сторінці.
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
                                                // Якщо Chrome впаде/буде вбитий пізніше (OOM, краш) — скидаємо кеш,
                                                                            // ЯКЩО це досі той самий запуск (щоб не затерти вже новіший, якщо
                                                                            // между тим хтось встиг перезапустити браузер вручну).
                                                                            browser.on('disconnected', () => {
                                                                                                console.error('[retail-parser] Puppeteer-браузер відключився (crash/kill) — перезапущу на наступному запиті');
                                                                                                if (browserPromise === thisLaunch) browserPromise = null;
                                                                            });
                                                return browser;
                              });
                              browserPromise = thisLaunch;
                              // Якщо сам запуск провалився — скидаємо кеш, інакше getBrowser()
                // назавжди повертав би той самий відхилений Promise (і Puppeteer був
                // би "мертвий" для всього сервера до ручного рестарту).
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
              if (proxyBrowserPromise) {
                              try {
                                                const b = await proxyBrowserPromise;
                                                await b.close();
                              } catch {
                                                // ігноруємо — можливо, вже мертвий/відключений
                              }
                              proxyBrowserPromise = null;
              }
}

// ---------- Обмеження одночасних Puppeteer-сторінок ----------
// Знову піднято до 6 — тариф Render повернуто на Pro (4GB/2CPU) саме для
// пришвидшення повного проходу по каталогу (1619 товарів, Jabko/Yablyka
// займають по 20-45с на товар, і на Standard/3 слоти повний прохід
// розтягувався на ~10-12 годин). НЕ піднімати вище без подальшого
// апгрейду тарифу — на 2GB це раніше призводило до OOM-краш-лупу
// (перевірено на практиці).
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

// ---------- Низькорівневий fetch (для кастомної логіки магазину) ----------
// На відміну від fetchHtml — повертає сирий Response (щоб можна було читати
// заголовки/куки), підтримує довільний метод/тіло/заголовки. Використовується
// магазинами з нестандартним пошуком (напр. GRO: cookie+CSRF, JustBuy: JSON API).
export async function rawFetch(url, opts = {}) {
              const controller = new AbortController();
              const t = setTimeout(() => controller.abort(), opts.timeout ?? FETCH_TIMEOUT_MS);
              // ІНЦИДЕНТ (13.07): раніше проксі бралось з пулу автоматично на КОЖЕН
  // запит незалежно від магазину — і коли весь пул Webshare впав
  // (ERR_TUNNEL_CONNECTION_FAILED на всіх 10 IP), це миттєво поклало
  // GRO/Jabko/Yablyka/JustBuy, які проксі ніколи не потребували й
  // прекрасно працювали напряму з IP Render. Тепер проксі — суворо
  // opt-in через opts.useProxy (виставляє лише config.useProxy у
  // scrapeStore, тобто зараз тільки iStore/МТА). Якщо пул проксі знову
  // впаде — постраждають тільки ці два магазини (які й так заблоковані
  // без проксі), а не весь парсер.
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

export async function fetchHtml(url, opts = {}) {
              const res = await rawFetch(url, {
                              headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
                              useProxy: opts.useProxy,
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
const ACCESSORY_RE = /^(чохол|чохли|плівка|скло|захисне|кабель|адаптер|зарядн|підставка|тримач|ремінець|ремінці|стрічка|кейс|сумка|бампер|перехідник|заряд[а-яіїєґ]*\s*пристрій|дисковод|накладка|захист)(?![a-zа-яіїєґ'])/i;

// Другий, незалежний від позиції в назві сигнал "це аксесуар/запчастина
// ДО чогось, а не саме воно" — виявлено на прикладі PS5: запит "Sony
// PlayStation 5 SLIM Disc 1TB White" (сама консоль) на GRO збігався з
// "Дисковод для консолі Sony PlayStation 5 Slim Disc Drive" (окремий
// привід, що продається як апгрейд для Digital-версії) — токени
// "sony/playstation/5/slim/disc" всі присутні, а жодного кольор-/
// сторедж-конфлікту ACCESSORY_RE (яка дивиться лише на ПЕРШЕ слово) не
// впіймала, бо "Дисковод" ще не був у списку. Фраза "для консолі/
// приставки/телефону/ноутбука/системи" — надійна ознака аксесуара
// незалежно від того, яким словом починається назва, і сам запит на
// товар практично ніколи так не сформульований.
const ACCESSORY_FOR_RE = /\bдля\s+(консол[іе]|приставк[иа]|телефон[ау]|смартфон[ау]|ноутбук[ау]|систем[иа]|годинник[ау]|планшет[ау])\b/i;

export function isAccessoryTitle(title) {
              const t = (title || '').trim();
              return ACCESSORY_RE.test(t) || ACCESSORY_FOR_RE.test(t);
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
              // Ігрові консолі: Disc/Digital — принципово різні SKU (з приводом чи
              // без) за дуже схожою рештою назви, легко переплутати (виявлено на
              // прикладі PS5 SLIM — запит "...Disc..." збігався з "...Digital
              // Edition..." без жодного штрафу).
              'disc', 'digital',
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
                        // Обмежуємо довжину тексту контейнера (3000 симв., було 1200 — 14.07) —
                        // інакше на компактних HTML-фрагментах (напр. AJAX-відповідь пошуку)
                        // можна "проскочити" на рівень, що обгортає весь список товарів, і
                        // підхопити ціну зовсім іншого, не пов'язаного товару (перевірено на
                        // практиці — GRO: рівень "картки" ~500 симв., рівень "усього списку"
                        // вже 4000+). 1200 БУЛО ЗАНАДТО МАЛО: перевірено вручну на iStore.ua
                        // (14.07) — контейнер РІВНЯ КАРТКИ товару там ~1500 симв. (Bitrix,
                        // клас .in_section_products), а на mta.ua — ~1840 симв. (.product_card),
                        // тобто в ОБОХ випадках старий поріг 1200 обривав пошук ДО того, як
                        // алгоритм діставався рівня з ціною, і extractCandidates* завжди
                        // повертав 0 кандидатів для цих двох магазинів. Новий поріг 3000
                        // все одно на порядок менший за "рівень усього списку" (9200+ на
                        // iStore, 46000+ на mta.ua), тож підміна ціни іншого товару так само
                        // виключена.
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

// opts.useProxy (14.07) — якщо true, сторінка відкривається в ОКРЕМОМУ
// проксованому браузері (getProxyBrowser(), див. вище) замість спільного
// getBrowser(). Зараз це лише iStore/МТА (config.useProxy у scrapeStore).
export async function withPuppeteerPage(fn, opts = {}) {
              const browser = opts.useProxy ? await getProxyBrowser() : await getBrowser();
              let page;
              try {
                              page = await withTimeout(browser.newPage(), NEW_PAGE_TIMEOUT_MS, 'Puppeteer: newPage() перевищив ліміт часу');
              } catch (e) {
                              // Браузер технічно "живий" (не встиг подати подію disconnected), але
                // не відповідає — примусово вбиваємо процес і скидаємо кеш, щоб
                // наступний запит підняв свіжий інстанс замість вічного очікування.
                // ВАЖЛИВО: скидаємо кеш ЛИШЕ того браузера, який щойно використали —
                // так падіння проксованого інстансу (iStore/МТА) не чіпає звичайний
                // (Jabko/Yablyka), і навпаки.
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
                              // Жорстка стеля понад усі внутрішні тайм-аути (nav timeout 20с +
                // набір тексту + очікування дорендеру) — гарантує, що один "зависший"
                // товар не заблокує Puppeteer-слот назавжди, а разом з ним — і всю
                // чергу (нічний крон ТА ручне "Оновити ціни" для інших товарів).
                return await withTimeout(fn(page), PAGE_WORK_TIMEOUT_MS, 'Puppeteer: перевищено ліміт часу на сторінку');
              } finally {
                              await page.close().catch(() => {});
              }
}

// Те саме, але з обмеженням кількості одночасних сторінок (див.
// MAX_CONCURRENT_PUPPETEER вище) — використовується в scrapeStore, коли
// кілька магазинів скрапляться паралельно (Promise.allSettled у server.js).
// Слот СПІЛЬНИЙ для обох браузерів (проксованого і звичайного) — обидва
// однаково важать по пам'яті, тож ліміт має рахувати їх разом.
async function withPuppeteerPageLimited(fn, opts = {}) {
              await acquirePuppeteerSlot();
              try {
                              return await withPuppeteerPage(fn, opts);
              } finally {
                              releasePuppeteerSlot();
              }
}

// Дочікування Cloudflare-виклику ("Just a moment...", managed challenge)
// (14.07) — виявлено на прикладі mta.ua: page.goto({waitUntil:
// 'domcontentloaded'}) резолвиться на ПРОМІЖНІЙ сторінці Cloudflare, яка
// сама собою (JS-редіректом) заміняється на реальний сайт за кілька
// секунд — без явного очікування typeIntoSiteSearch одразу шукає поле
// пошуку на ще не завантаженому реальному DOM і завжди повертає false.
// Це саме той HTTP 403, який раніше (до резидентного проксі) хибно
// списували на бан за IP — Cloudflare віддає 403 на голий fetch (немає
// виконання JS -> виклик ніколи не пройде), а не сам сайт блокує адресу.
// Перевірка дешева (один evaluate) і майже завжди одразу повертає
// true для сайтів без Cloudflare — безпечно для всіх магазинів.
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

// Іконка "розгорнути пошук" (14.07) — виявлено на прикладі iStore.ua: поле
// пошуку взагалі ВІДСУТНЄ в DOM, доки не клікнути іконку-лупу в шапці (не
// просто приховане стилями — його там немає, доки JS не домонтує).
// SEARCH_INPUT_SELECTORS нижче тому нічого не знаходять одразу після
// goto(). Пробуємо клікнути типову іконку пошуку й почекати, перш ніж
// остаточно здатися — якщо на сторінці й так є видиме поле (як у
// більшості магазинів), цей крок просто не спрацює (жодного матчу) і
// нічого не зламає.
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

// Дочікуємось стабілізації контенту сторінки замість фіксованої паузи —
// на сайтах з поступовим (streaming/RSC) рендером видачі (перевірено на
// практиці: Yablyka) фіксовані 1200мс не завжди вистачало: бейдж
// кешбеку вже встигав відрендеритись, а сам блок ціни — ще ні, і парсер
// хапав суму кешбеку замість ціни. Порівнюємо довжину видимого тексту
// сторінки у 2 заміри — якщо однакова, вважаємо, що дорендер завершився.
// Винесено в окрему функцію (14.07), бо тепер потрібна і в
// typeIntoSiteSearch (після Enter), і в scrapeStore напряму (коли
// Puppeteer одразу відкриває URL видачі пошуку, без набору тексту).
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
                              // Жодного видимого поля одразу — пробуємо розкрити пошук через іконку
                // (див. коментар вище про iStore.ua) і повторно пошукати поле.
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

// ---------- Оркестратор одного магазину ----------
// config:
//   name                     — назва магазину (як у RetailStore.store)
//   baseUrl                  — головна сторінка (для fallback через Puppeteer)
//   searchUrl(q)              — функція, що будує URL сторінки видачі пошуку (пробуємо plain fetch)
//   usePuppeteerFallback      — чи пробувати headless-браузер, якщо fetch не дав збігу
//   useProxy                  — чи використовувати проксі-пул для fetch-кроку цього
//                                магазину (opt-in; зараз тільки iStore/МТА — див.
//                                коментар в rawFetch() про інцидент 13.07)
//   skipPuppeteerWithoutProxy — не пробувати Puppeteer, якщо проксі-пул не задано
//                                (для магазинів, які блокують за IP датацентру —
//                                Puppeteer з того ж IP теж буде заблоковано,
//                                тож спроба лише марно вантажить сервер)
//   puppeteerUseSearchUrl     — (14.07) замість відкривати baseUrl і друкувати
//                                запит у пошук сайту (typeIntoSiteSearch —
//                                залежить від фрагільного клієнтського UI:
//                                на iStore.ua поле пошуку ховається за
//                                іконкою-лупою, і на практиці навіть
//                                СПРАВЖНІЙ, довірений клік по ній не завжди
//                                відкриває поле — перевірено вручну, друга
//                                спроба того самого кліку не спрацювала),
//                                Puppeteer одразу відкриває config.searchUrl(q)
//                                напряму. Це та сама адреса видачі пошуку, яку
//                                й так намагається fetch-крок — просто цього
//                                разу справжнім браузером (обходить
//                                TLS/HTTP-відбиток-блок) і з очікуванням
//                                Cloudflare-виклику. Значно надійніше за
//                                емуляцію кліку по UI, коли адреса видачі вже
//                                відома і серверно-рендериться (iStore, МТА).
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
                                                                    break; // сама сторінка/мережа впала — коротші запити цього не виправлять
                                                }
                              }
              }

  // 2) fallback — headless-браузер із набором тексту у пошук сайту
  if (config.usePuppeteerFallback !== false) {
                  if (config.skipPuppeteerWithoutProxy && !hasProxy()) {
                                    return {
                                                        store: config.name, price: 0, available: false, updated, status: 'error',
                                                        error: 'Заблоковано за IP хостингу — потрібен проксі (PROXY_URL)',
                                    };
                  }
                  // Раніше пробували 2 варіанти запиту через Puppeteer (повний +
                // найкоротший) — але це подвоює найгірший час на товар, коли жоден не
                // дав збігу (типово для Jabko/Yablyka під навантаженням). Лишаємо лише
                // повний запит — так кожна спроба вдвічі коротша, і черга рухається
                // швидше.
                const puppeteerQueries = [queries[0]];
                  try {
                                    for (const query of puppeteerQueries) {
                                                        const result = await withPuppeteerPageLimited(async (page) => {
                                                                              let cfCleared = null;
                                                                              if (config.puppeteerUseSearchUrl) {
                                                                                                      await page.goto(config.searchUrl(query), { waitUntil: 'domcontentloaded' });
                                                                                                      // Тайм-аут підняно 10с -> 20с (14.07, друга діагностична спроба) —
                                                                                // перша спроба з тимчасовим логуванням показала candidates=0 для
                                                                                // МТА (на відміну від 12 кандидатів при ручній перевірці з
                                                                                // власного IP за ~6с) при candidates=2 (лише "N відгуків"
                                                                                // посилання, не справжні назви товарів) для iStore — обидва
                                                                                // симптоми узгоджуються з гіпотезою, що через повільніший
                                                                                // резидентний проксі Cloudflare-виклик (МТА) чи AJAX-дорендер
                                                                                // картки товару (iStore) просто не встигають за старий тайм-аут.
                                                                                cfCleared = await waitForCloudflareChallenge(page, 20000);
                                                                                                      await waitForContentStabilization(page);
                                                                                          } else {
                                                                                                      await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
                                                                                                      const typed = await typeIntoSiteSearch(page, query);
                                                                                                      if (!typed) return null;
                                                                                          }
                                                                              const candidates = await extractCandidatesPuppeteer(page);
                                                                              // ТИМЧАСОВЕ діагностичне логування (14.07, розширено) — поки
                                                                                                                // з'ясовуємо, чому iStore/МТА досі повертають "no-product".
                                                                                                                // Додано: чи минув Cloudflare-виклик (cfCleared, тільки для
                                                                                                                // магазинів з puppeteerUseSearchUrl), фінальний title/URL сторінки
                                                                                                                // (щоб побачити редірект чи "Just a moment" в проді), довжину
                                                                                                                // видимого тексту й кількість <a href> — щоб порівняти з ручною
                                                                                                                // перевіркою (iStore: 4 кандидати/2339 симв. на рівні картки;
                                                                                                                // МТА: 12 кандидатів). Прибрати, коли причина знайдена й
                                                                                                                // підтверджена.
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

  // usePuppeteerFallback: false (наразі жоден магазин так не налаштований,
  // 14.07 — iStore/МТА теж отримали Puppeteer-фолбек через резидентний
  // проксі, див. вище) — якщо ще й fetch-крок впав (403 тощо), чесно
  // повертаємо 'error' з причиною замість мовчазного 'no-product', щоб
  // дашборд у Налаштуваннях не показував це як "товару немає на сайті".
  if (fetchFailed) {
                  return { store: config.name, price: 0, available: false, updated, status: 'error', error: fetchFailReason };
  }
              return { store: config.name, price: 0, available: false, updated, status: 'no-product' };
}

export { cheerio };
