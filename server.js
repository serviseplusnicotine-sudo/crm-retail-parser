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

const app = express();
app.use(cors());
app.use(express.json());

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
    return {
      store: targetStores[i],
      price: 0,
      available: false,
      updated: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
      status: 'error',
    };
  });

  res.json({ results });
});

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
