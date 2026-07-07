import { scrapeStore } from './common.js';

// iStore.ua (Bitrix). Точний URL пошукової видачі не підтверджено на 100% —
// пробуємо ймовірний Bitrix-шлях /ua/search/. Сайт блокує запити з IP
// датацентрів (403) — без проксі Puppeteer з того ж IP теж буде
// заблоковано, тож skipPuppeteerWithoutProxy економить ресурси сервера.
const config = {
  name: 'iStore',
  baseUrl: 'https://www.istore.ua/ua/',
  searchUrl: (q) => `https://www.istore.ua/ua/search/?q=${encodeURIComponent(q)}`,
  skipPuppeteerWithoutProxy: true,
};

export function scrapeIStore(product) {
  return scrapeStore(config, product);
}
