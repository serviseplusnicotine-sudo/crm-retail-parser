import { scrapeStore } from './common.js';

// JustBuy (justbuy.com.ua) — головна сторінка рендериться сервером (велике
// дерево категорій присутнє у HTML без JS), тож, ймовірно, і видача
// пошуку теж. Точний URL параметра пошуку не підтверджено — пробуємо
// найпоширеніший Magento-подібний шлях, з Puppeteer-фолбеком.
const config = {
  name: 'JustBuy',
  baseUrl: 'https://justbuy.com.ua/en',
  searchUrl: (q) => `https://justbuy.com.ua/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
};

export function scrapeJustBuy(product) {
  return scrapeStore(config, product);
}
