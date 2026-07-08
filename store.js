// Просте файлове сховище на диску сервера — щоб нічний крон (cron.js) знав
// які товари перевіряти і куди складати результат, без окремої СУБД.
//
// Persistent disk: на Render підключено окремий SSD-диск, змонтований у
// /var/data (Disk tab у дашборді сервісу). Тільки файли під цим шляхом
// переживають деплой — усе інше на диску сервісу обнуляється при кожному
// пуші коду. Тому пишемо кеш саме туди, а не в папку поруч з кодом.
// Локально (npm run dev) /var/data не існує — тоді падаємо назад на data/
// поруч зі server.js, як і раніше.
const RENDER_DISK_PATH = '/var/data';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  || (fs.existsSync(RENDER_DISK_PATH) ? RENDER_DISK_PATH : path.join(__dirname, 'data'));
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const PRICES_FILE = path.join(DATA_DIR, 'prices.json');
console.log(`[retail-parser] кеш товарів/цін зберігається у ${DATA_DIR}${DATA_DIR === RENDER_DISK_PATH ? ' (persistent disk)' : ' (тимчасово, не переживе деплой)'}`);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// products: [{ id, name, model, tags }]
export function saveProducts(products) {
  ensureDataDir();
  const minimal = (products || []).map(p => ({
    id: p.id, name: p.name, model: p.model, tags: p.tags || {},
  }));
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify({
    products: minimal,
    syncedAt: new Date().toISOString(),
  }), 'utf8');
}

export function loadProducts() {
  try {
    const raw = fs.readFileSync(PRODUCTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.products) ? data.products : [];
  } catch {
    return [];
  }
}

export function loadPriceCache() {
  try {
    const raw = fs.readFileSync(PRICES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function savePriceCache(cache) {
  ensureDataDir();
  fs.writeFileSync(PRICES_FILE, JSON.stringify(cache), 'utf8');
}

const MAX_HISTORY_POINTS = 60;

// results: RetailStore[] (з common.js/scrapeStore)
// Крім останніх результатів, ведемо легкий щоденний "зріз" мінімальної
// доступної роздрібної ціни — це і є реальні дані для колонки "7-д тренд"
// (для товарів з живого Google Sheets раніше взагалі не було жодної
// історії цін, тому тренд завжди був порожній — genPriceHistory() існував
// лише в демо-каталозі). Один запис на календарний день: повторні виклики
// того ж дня перезаписують сьогоднішній запис, а не плодять дублі.
export function updatePriceCacheForProduct(productId, results) {
  const cache = loadPriceCache();
  const prev = cache[productId];
  const history = Array.isArray(prev?.history) ? prev.history.slice() : [];

  const availablePrices = (results || [])
    .filter(r => r && r.available && typeof r.price === 'number' && r.price > 0)
    .map(r => r.price);
  const minPrice = availablePrices.length > 0 ? Math.min(...availablePrices) : null;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (minPrice !== null) {
    const todayIdx = history.findIndex(h => h.date === today);
    if (todayIdx >= 0) history[todayIdx] = { date: today, price: minPrice };
    else history.push({ date: today, price: minPrice });
  }
  while (history.length > MAX_HISTORY_POINTS) history.shift();

  cache[productId] = { results, updatedAt: new Date().toISOString(), history };
  savePriceCache(cache);
}
