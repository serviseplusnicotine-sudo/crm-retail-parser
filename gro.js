import { scrapeStore } from './common.js';

// GRO / ex Grokholsky (grokholsky.com) — тех-магазин техніки Apple.
// Точний URL пошукової видачі не підтверджено, тож основний шлях —
// Puppeteer із набором тексту у видиме поле пошуку сайту.
const config = {
  name: 'GRO',
  baseUrl: 'https://grokholsky.com/ua/',
  searchUrl: (q) => `https://grokholsky.com/ua/search?search=${encodeURIComponent(q)}`,
};

export function scrapeGRO(product) {
  return scrapeStore(config, product);
}
