import { scrapeStore } from './common.js';

// Jabko / Ябко (jabko.ua). Категорійні сторінки (напр. /iphone/) рендеряться
// сервером — це підтверджено. Точний URL пошукової видачі не підтверджено,
// тож пробуємо ймовірний /search?search=..., а якщо кандидатів немає —
// падаємо у Puppeteer і друкуємо запит у видиме поле пошуку сайту.
const config = {
  name: 'Jabko',
  baseUrl: 'https://jabko.ua/',
  searchUrl: (q) => `https://jabko.ua/search?search=${encodeURIComponent(q)}`,
};

export function scrapeJabko(product) {
  return scrapeStore(config, product);
}
