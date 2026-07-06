import { scrapeStore } from './common.js';

// iStore.ua (Bitrix). Точний URL пошукової видачі не підтверджено на 100% —
// пробуємо ймовірний Bitrix-шлях /ua/search/, а якщо нічого не знайдено,
// автоматично падаємо у Puppeteer і друкуємо запит у видиме поле пошуку
// на сайті (див. server/scrapers/common.js -> scrapeStore).
const config = {
  name: 'iStore',
  baseUrl: 'https://www.istore.ua/ua/',
  searchUrl: (q) => `https://www.istore.ua/ua/search/?q=${encodeURIComponent(q)}`,
};

export function scrapeIStore(product) {
  return scrapeStore(config, product);
}
