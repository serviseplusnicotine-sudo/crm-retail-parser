import { scrapeStore } from './common.js';

// Yablyka / ЯБЛУКА — бренд яблука.ua мігрував на домен ya.ua (підтверджено
// внутрішніми посиланнями на сайті). Пошук виглядає як SPA (клієнтський
// рендер), тому швидкий fetch-шлях, скоріш за все, не спрацює і основним
// буде Puppeteer-шлях (набір тексту у видиме поле пошуку сайту).
const config = {
  name: 'Yablyka',
  baseUrl: 'https://ya.ua/',
  searchUrl: (q) => `https://ya.ua/search?productQuery=${encodeURIComponent(q)}&page=1`,
};

export function scrapeYablyka(product) {
  return scrapeStore(config, product);
}
