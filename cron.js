// Нічне фонове оновлення цін по ВСІХ товарах, які фронтенд коли-небудь
// синхронізував через POST /api/products/sync (див. server.js/index.js).
// Завдяки цьому кнопка "Оновити ціни" на картці товару стає опційною —
// свіжі ціни вже лежать у кеші (GET /api/products/prices) до того, як
// хтось відкрив CRM вранці.
//
// Пауза між товарами (DELAY_BETWEEN_MS) навмисно немаленька — щоб не
// довбати магазини частими запитами й не привернути додаткову увагу
// антибот-систем понад те, що вже є (див. common.js).

import cron from 'node-cron';
import { SCRAPERS, PARSED_STORE_NAMES } from './registry.js';
import { loadProducts, updatePriceCacheForProduct } from './store.js';

const CRON_SCHEDULE = process.env.PRICE_CRON_SCHEDULE || '0 3 * * *'; // 03:00 щоночі
// Скільки товарів обробляємо одночасно. Це БЕЗПЕЧНО піднімати — важкий
// ресурс (Puppeteer) має власний окремий семафор на 3 одночасні сторінки
// (MAX_CONCURRENT_PUPPETEER у common.js), тож паралелізм тут лише
// пришвидшує "легкі" (cheerio/fetch) магазини й чергу на сам семафор, а
// не роздуває реальне навантаження понад те, що сервер вже витримує.
const CONCURRENCY = Number(process.env.PRICE_CRON_CONCURRENCY) || 8;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Живий прогрес для UI (Налаштування → Стан парсера) ----------
// РАНІШЕ єдиним слідом того, що робить нічне оновлення, були console.log
// у Render-логах — з фронтенду взагалі не було видно, чи крон "висить" на
// одному товарі, чи просто повільно йде далі. Тепер тримаємо легкий
// in-memory стан (не переживе рестарт сервера — і не повинен, це лише
// live-індикатор поточного проходу) і віддаємо його через
// GET /api/products/parser-status (server.js).
const MAX_LOG = 40;
const progress = {
    running: false,
    total: 0,
    done: 0,
    startedAt: null,
    finishedAt: null,
    currentBatch: [],
    recentLog: [],
};

function logEvent(name, summary) {
    progress.recentLog.unshift({ at: new Date().toISOString(), name, summary });
    if (progress.recentLog.length > MAX_LOG) progress.recentLog.length = MAX_LOG;
}

export function getParserProgress() {
    return progress;
}

async function scrapeOneProduct(product) {
    const settled = await Promise.allSettled(
          PARSED_STORE_NAMES.map((storeName) => SCRAPERS[storeName](product))
        );
    const results = settled.map((r, i) => {
          if (r.status === 'fulfilled') return r.value;
          return {
                  store: PARSED_STORE_NAMES[i],
                  price: 0,
                  available: false,
                  updated: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
                  status: 'error',
          };
    });
    updatePriceCacheForProduct(product.id, results);
    const ok = results.filter(r => r.status === 'ok').length;
    const errored = results.filter(r => r.status === 'error').length;
    const summary = errored > 0 ? `${ok}/${PARSED_STORE_NAMES.length} знайдено, ${errored} з помилкою` : `${ok}/${PARSED_STORE_NAMES.length} знайдено`;
    logEvent(product.name || product.model || product.id, summary);
}

let running = false;

async function runNightlyUpdate() {
    if (running) {
          console.log('[retail-parser] нічне оновлення вже виконується — пропускаю новий запуск');
          return;
    }
    running = true;
    progress.running = true;
    progress.startedAt = new Date().toISOString();
    progress.finishedAt = null;
    progress.done = 0;
    progress.currentBatch = [];
    progress.recentLog = [];
    try {
          const products = loadProducts();
          progress.total = products.length;
          console.log(`[retail-parser] нічне оновлення почалось: товарів ${products.length}, паралельно ${CONCURRENCY}`);
          let done = 0;
          let cursor = 0;
          async function worker() {
                  while (cursor < products.length) {
                            const product = products[cursor++];
                            const label = product.name || product.model || product.id;
                            progress.currentBatch.push(label);
                            try {
                                        await scrapeOneProduct(product);
                            } catch (e) {
                                        console.error(`[retail-parser] нічне оновлення: помилка для товару ${product.id}: ${e instanceof Error ? e.message : e}`);
                                        logEvent(label, 'помилка обробки товару');
                            }
                            const idx = progress.currentBatch.indexOf(label);
                            if (idx !== -1) progress.currentBatch.splice(idx, 1);
                            done++;
                            progress.done = done;
                            if (done % 20 === 0) console.log(`[retail-parser] нічне оновлення: прогрес ${done}/${products.length}`);
                            await sleep(150 + Math.random() * 250);
                  }
          }
          await Promise.all(Array.from({ length: Math.min(CONCURRENCY, products.length || 1) }, worker));
          console.log(`[retail-parser] нічне оновлення завершено: ${done}/${products.length}`);
    } finally {
          running = false;
          progress.running = false;
          progress.finishedAt = new Date().toISOString();
          progress.currentBatch = [];
    }
}

export function startPriceCron() {
    cron.schedule(CRON_SCHEDULE, () => {
          runNightlyUpdate().catch((e) => console.error('[retail-parser] нічне оновлення впало:', e));
    });
    console.log(`[retail-parser] нічний крон налаштовано: "${CRON_SCHEDULE}" (паралельно товарів: ${CONCURRENCY})`);
}

export function isNightlyUpdateRunning() {
    return running;
}

export { runNightlyUpdate };
