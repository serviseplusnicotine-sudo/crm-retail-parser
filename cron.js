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
}

let running = false;

// На ~1000+ товарах послідовна обробка по одному (навіть з паузою всього
// 4с) розтягувалась на години — і якщо сервер передеплоївся раніше, ніж
// крон встиг дійти до кінця каталогу, диск (не persistent між деплоями,
// див. store.js) обнулявся й усе починалось спочатку. Пул із декількох
// товарів одночасно (CONCURRENCY) скорочує повний прохід по каталогу з
// годин до приблизно 30-40 хвилин на ~1000 товарів.
async function runNightlyUpdate() {
  if (running) {
    console.log('[retail-parser] нічне оновлення вже виконується — пропускаю новий запуск');
    return;
  }
  running = true;
  try {
    const products = loadProducts();
    console.log(`[retail-parser] нічне оновлення почалось: товарів ${products.length}, паралельно ${CONCURRENCY}`);
    let done = 0;
    let cursor = 0;
    async function worker() {
      while (cursor < products.length) {
        const product = products[cursor++];
        try {
          await scrapeOneProduct(product);
        } catch (e) {
          console.error(`[retail-parser] нічне оновлення: помилка для товару ${product.id}: ${e instanceof Error ? e.message : e}`);
        }
        done++;
        if (done % 20 === 0) console.log(`[retail-parser] нічне оновлення: прогрес ${done}/${products.length}`);
        // Невелика ввічлива пауза з джиттером — щоб "легкі" (не-Puppeteer)
        // магазини не отримували одночасний сплеск запитів з усіх воркерів.
        await sleep(150 + Math.random() * 250);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, products.length || 1) }, worker));
    console.log(`[retail-parser] нічне оновлення завершено: ${done}/${products.length}`);
  } finally {
    running = false;
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

// Дозволяє запустити оновлення вручну (напр. через /api/products/refresh-now
// або одразу після /api/products/sync, якщо кеш цін ще порожній/застарілий).
export { runNightlyUpdate };
