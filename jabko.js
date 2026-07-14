import { scrapeStore } from './common.js';

// Jabko / Ябко (jabko.ua) — OpenCart. Підтверджено вручну: пошук живе на
// /index.php?route=product/search&search=... (повертає 200), але видача
// рендериться клієнтським JS (у сирому HTML цін немає), тож швидкий шлях
// зазвичай не знайде кандидатів і природньо впаде в Puppeteer-фолбек
// (набір тексту у видиме поле пошуку сайту).
//
// skipCheerioFetch: true (14.07) — до цього моменту прапор тут НЕ був
// виставлений, хоча коментар вище вже роками констатував, що швидкий шлях
// "зазвичай не знайде кандидатів". Це означало, що для КОЖНОГО товару
// парсер спочатку реально ходив на jabko.ua окремим fetch-запитом під
// кожен варіант запиту з buildQueryVariants() (їх буває 4-6), кожен раз
// марно (сирий HTML без цін), і лише ПОТІМ падав у Puppeteer. На практиці
// це додавало кілька зайвих реальних HTTP-запитів і секунд затримки на
// КОЖЕН товар Jabko ще ДО того, як товар взагалі потрапляв у чергу
// Puppeteer — і зайве навантажувало сам jabko.ua. Yablyka (той самий клас
// проблеми — SPA/стрімінговий рендер) вже мала цей прапор виставленим.
// Прибираємо зайвий крок і одразу йдемо в Puppeteer, як і для Yablyka.
const config = {
    name: 'Jabko',
    baseUrl: 'https://jabko.ua/',
    searchUrl: (q) => `https://jabko.ua/index.php?route=product/search&search=${encodeURIComponent(q)}`,
    skipCheerioFetch: true,
};

export function scrapeJabko(product) {
    return scrapeStore(config, product);
}
