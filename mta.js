import { scrapeStore } from './common.js';

// МТА (mta.ua) — сайт серверно-рендерить видачу пошуку за адресою
// /search?search=... (перевірено вручну під час розробки), тому зазвичай
// достатньо швидкого шляху (fetch + cheerio), Puppeteer майже не знадобиться.
const config = {
  name: 'МТА',
  baseUrl: 'https://mta.ua/',
  searchUrl: (q) => `https://mta.ua/search?search=${encodeURIComponent(q)}`,
};

export function scrapeMTA(product) {
  return scrapeStore(config, product);
}
