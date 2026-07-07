import { scrapeStore } from './common.js';

// Jabko / Ябко (jabko.ua) — OpenCart. Підтверджено вручну: пошук живе на
// /index.php?route=product/search&search=... (повертає 200), але видача
// рендериться клієнтським JS (у сирому HTML цін немає), тож швидкий шлях
// зазвичай не знайде кандидатів і природньо впаде в Puppeteer-фолбек
// (набір тексту у видиме поле пошуку сайту).
const config = {
  name: 'Jabko',
  baseUrl: 'https://jabko.ua/',
  searchUrl: (q) => `https://jabko.ua/index.php?route=product/search&search=${encodeURIComponent(q)}`,
};

export function scrapeJabko(product) {
  return scrapeStore(config, product);
}
