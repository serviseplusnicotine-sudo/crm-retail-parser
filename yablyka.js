import { scrapeStore } from './common.js';

// Yablyka / ЯБЛУКА — бренд яблука.ua мігрував на домен ya.ua (підтверджено
// внутрішніми посиланнями на сайті). Пошук виглядає як SPA (клієнтський
// рендер), тому швидкий fetch-шлях, скоріш за все, не спрацює і основним
// буде Puppeteer-шлях (набір тексту у видиме поле пошуку сайту).
const config = {
  name: 'Yablyka',
  baseUrl: 'https://ya.ua/',
  searchUrl: (q) => `https://ya.ua/search?productQuery=${encodeURIComponent(q)}&page=1`,
  // ya.ua — Next.js зі стрімінговим SSR: сирий HTML (без виконання JS)
  // може містити лише суму кешбеку, а не фінальну ціну — вона
  // довантажується пізніше. Тому швидкий fetch/cheerio-шлях для цього
  // магазину пропускаємо і одразу йдемо через Puppeteer, який чекає
  // повного дорендеру сторінки.
    puppeteerUseSearchUrl: true,
  useFlareSolverr: true,
};

export function scrapeYablyka(product) {
  return scrapeStore(config, product);
}
