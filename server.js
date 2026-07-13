// Backend для реального парсера роздрібних цін.
//
// Навіщо окремий сервер: прототип CRM — це чистий React/Vite фронтенд без
// бекенду (див. src/app/context/AppContext.tsx). Браузер не може напряму
// скрапити сторонні сайти (CORS, і більшість магазинів все одно
// заблокує XHR-запит з чужого домену). Тому реальний обхід iStore, GRO,
// Jabko, Yablyka, МТА і JustBuy виконує цей Node-сервер (fetch/Puppeteer
// не обмежені CORS), а фронтенд лише звертається до нього по /api.
//
// Запуск:  npm run server   (див. package.json)
// Фронтенд ходить на /api/*, що проксується у vite.config.ts на
// http://localhost:4000 під час `npm run dev`.

import express from 'express';
import cors from 'cors';
import { SCRAPERS, PARSED_STORE_NAMES } from './registry.js';
import { closeBrowser } from './common.js';
import { saveProducts, loadPriceCache } from './store.js';
import { startPriceCron, runNightlyUpdate, isNightlyUpdateRunning, getParserProgress } from './cron.js';

const app = express();
app.use(cors());
// Дефолтний ліміт express.json() — 100kb. При ~1095 товарах у каталозі
// Ігоря POST /api/products/sync важить ~195kb і мовчки падав з 413 Payload
// Too Large — тобто сервер ФАКТИЧНО НІКОЛИ не отримував список товарів
// для нічного скану, і кеш цін залишався порожнім незалежно від крону чи
// його швидкості. Це, найімовірніше, і була справжня причина "на сервері
// нихуя не кешується".
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 4000;

app.get('/api/health', (_req, res) => {
    res.json({ ok: true, stores: PARSED_STORE_NAMES });
});

// POST /api/retail-prices
// body: { product: { id, name, model, tags: { storage?, color?, ... } }, stores?: string[] }
// -> { results: RetailStore[] }
app.post('/api/retail-prices', async (req, res) => {
    const { product, stores } = req.body || {};
    if (!product || (!product.name && !product.model)) {
          return res.status(400).json({ error: 'Потрібно передати product з полем name або model' });
    }

           const targetStores = (Array.isArray(stores) && stores.length > 0)
      ? stores.filter(s => SCRAPERS[s])
                 : PARSED_STORE_NAMES;

           if (targetStores.length === 0) {
                 return res.status(400).json({ error: 'Жоден із переданих магазинів не підтримується парсером' });
           }

           const settled = await Promise.allSettled(
                 targetStores.map(storeName => SCRAPERS[storeName](product))
               );

           const results = settled.map((r, i) => {
                 if (r.status === 'fulfilled') return r.value;
                 console.error(`[retail-parser] ${targetStores[i]} failed:`, r.reason);
                 return {
                         store: targetStores[i],
                         price: 0,
                         available: false,
                         updated: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
                         status: 'error',
                         error: r.reason instanceof Error ? r.reason.message : String(r.reason),
                 };
           });

           res.json({ results });
});

// POST /api/products/sync
// body: { products: [{ id, name, model, tags }] }
// Фронтенд викликає це при відкритті CRM (і після змін у товарах), щоб
// сервер знав, які товари перевіряти вночі (див. cron.js). Дані самих
// товарів (ціни закупки, постачальники тощо) сюди НЕ передаються — лише
// мінімум, потрібний для пошуку в магазинах.
app.post('/api/products/sync', (req, res) => {
    const { products } = req.body || {};
    if (!Array.isArray(products)) {
          return res.status(400).json({ error: 'Потрібно передати products: []' });
    }
    saveProducts(products);
    res.json({ ok: true, count: products.length });

           // Автопідігрів кешу цін: якщо після синку каталогу помітна частина
           // товарів ще не має жодного запису в кеші (типово — щойно після
           // деплою, коли диск обнулився, див. store.js), одразу запускаємо фонове
           // оновлення, не чекаючи нічного розкладу. Інакше "Роздріб" у таблиці
           // лишається порожнім, поки хтось вручну не відкриє кожну картку.
           if (!isNightlyUpdateRunning()) {
                 const cache = loadPriceCache();
                 const missing = products.filter(p => !cache[p.id]).length;
                 if (products.length > 0 && missing / products.length > 0.2) {
                         console.log(`[retail-parser] кеш цін неповний (${missing}/${products.length} без запису) — запускаю автопідігрів у фоні`);
                         runNightlyUpdate().catch((e) => console.error('[retail-parser] автопідігрів впав:', e));
                 }
           }
});

// GET /api/products/prices -> { prices: { [productId]: { results: RetailStore[], updatedAt } }, lastSyncedAt }
// Фронтенд тягне це при відкритті CRM, щоб одразу показати ціни з
// останнього нічного оновлення — без кліку на "Оновити ціни". lastSyncedAt
// (максимум updatedAt по всьому кешу) додано, щоб фронт міг показати не
// лише "скільки товарів готово" (retailCacheStatus), а й "наскільки свіжі
// ці дані" вже ПІСЛЯ завершення первинного прогріву кешу, коли самого лише
// прогресу "cached/total" вже недостатньо.
app.get('/api/products/prices', (_req, res) => {
    const prices = loadPriceCache();
    let lastSyncedAt = null;
    for (const key in prices) {
          const u = prices[key]?.updatedAt;
          if (u && (!lastSyncedAt || u > lastSyncedAt)) lastSyncedAt = u;
    }
    res.json({ prices, lastSyncedAt });
});

// GET /api/products/parser-status -> { running, total, done, startedAt,
// finishedAt, currentBatch, recentLog }
// Живий стан нічного/фонового проходу — раніше єдиним "індикатором" був
// агрегований retailCacheStatus (скільки товарів ВЖЕ в кеші взагалі), без
// відповіді на "а зараз щось відбувається, чи парсер завис". Тепер
// Налаштування → Стан парсера можуть показати реальний прогрес поточного
// проходу і останні оброблені товари (лог).
app.get('/api/products/parser-status', (_req, res) => {
    res.json(getParserProgress());
});

// POST /api/products/refresh-now — ручний тригер нічного оновлення (напр.
// для перевірки одразу після деплою, не чекаючи розкладу).
app.post('/api/products/refresh-now', (_req, res) => {
    runNightlyUpdate().catch((e) => console.error('[retail-parser] refresh-now впав:', e));
    res.json({ ok: true, message: 'Оновлення запущено у фоні, дивись логи' });
});

// POST /api/browser/restart — аварійний "рубильник": примусово закрити і
// скинути спільний Puppeteer-браузер. Тепер (після фіксу getBrowser() у
// common.js) сервер сам відновлюється після краху/зависання браузера, але
// цей ендпоінт лишається як ручний запобіжник — якщо щось піде не так
// по-новому, не чекати рестарту всього сервісу на Render.
app.post('/api/browser/restart', async (_req, res) => {
    try {
          await closeBrowser();
          res.json({ ok: true, message: 'Puppeteer-браузер закрито, новий підніметься на наступному запиті' });
    } catch (e) {
          res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
});

startPriceCron();

const server = app.listen(PORT, () => {
    console.log(`[retail-parser] сервер запущено на http://localhost:${PORT}`);
    console.log(`[retail-parser] магазини: ${PARSED_STORE_NAMES.join(', ')}`);
});

async function shutdown() {
    console.log('\n[retail-parser] зупиняюсь...');
    server.close();
    await closeBrowser();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
