import { scrapeStore } from './common.js';

// МТА (mta.ua) — сайт серверно-рендерить видачу пошуку за адресою
// /search?search=... (перевірено вручну під час розробки), тому зазвичай
// достатньо швидкого шляху (fetch + cheerio). Проте сайт блокує запити з IP
// датацентрів (403) — без проксі Puppeteer з того ж IP теж буде
// заблоковано, тож skipPuppeteerWithoutProxy економить ресурси сервера.
const config = {
  name: 'МТА',
  baseUrl: 'https://mta.ua/',
  searchUrl: (q) => `https://mta.ua/search?search=${encodeURIComponent(q)}`,
  skipPuppeteerWithoutProxy: true,
};

export function scrapeMTA(product) {
  return scrapeStore(config, product);
}
