// Просте файлове сховище на диску сервера — щоб нічний крон (cron.js) знав
// які товари перевіряти і куди складати результат, без окремої СУБД.
//
// ВАЖЛИВО (Render free/starter): диск НЕ persistent між деплоями — при
// кожному новому деплої (пуш коду) ці файли обнуляться, і фронтенду
// доведеться заново зробити /api/products/sync (робиться автоматично при
// відкритті CRM, див. AppContext.tsx). Дані живуть, поки сервер просто
// працює і рестартиться сам собою — це нормально для щоденного крону.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const PRICES_FILE = path.join(DATA_DIR, 'prices.json');

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

// results: RetailStore[] (з common.js/scrapeStore)
export function updatePriceCacheForProduct(productId, results) {
  const cache = loadPriceCache();
  cache[productId] = { results, updatedAt: new Date().toISOString() };
  savePriceCache(cache);
}
