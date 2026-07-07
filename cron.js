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
const DELAY_BETWEEN_MS = Number(process.env.PRICE_CRON_DELAY_MS) || 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let running = false;

async function runNightlyUpdate() {
  if (running) {
    console.log('[retail-parser] нічне оновлення вже виконується — пропускаю новий запуск');
    return;
  }
  running = true;
  try {
    const products = loadProducts();
    console.log(`[retail-parser] нічне оновлення почалось: товарів ${products.length}`);
    let done = 0;
    for (const product of products) {
      try {
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
      } catch (e) {
        console.error(`[retail-parser] нічне оновлення: помилка для товару ${product.id}: ${e instanceof Error ? e.message : e}`);
      }
      done++;
      if (done % 10 === 0) console.log(`[retail-parser] нічне оновлення: прогрес ${done}/${products.length}`);
      await sleep(DELAY_BETWEEN_MS);
    }
    console.log(`[retail-parser] нічне оновлення завершено: ${done}/${products.length}`);
  } finally {
    running = false;
  }
}

export function startPriceCron() {
  cron.schedule(CRON_SCHEDULE, () => {
    runNightlyUpdate().catch((e) => console.error('[retail-parser] нічне оновлення впало:', e));
  });
  console.log(`[retail-parser] нічний крон налаштовано: "${CRON_SCHEDULE}" (пауза між товарами ${DELAY_BETWEEN_MS}мс)`);
}

// Дозволяє запустити оновлення вручну (напр. через /api/products/refresh-now).
export { runNightlyUpdate };
