import { scrapeStore } from './common.js';

// МТА (mta.ua) — сайт серверно-рендерить видачу пошуку за адресою
// /search?search=... (перевірено вручну під час розробки), тому звичайно
// достатньо швидкого шляху (fetch + cheerio). Сайт блокує запити з IP
// датацентрів (403).
//
// useProxy: true — це ОДИН з двох магазинів (разом з iStore), для яких
// проксі-пул взагалі вмикається (opt-in, див. коментар в common.js/
// rawFetch про інцидент 13.07: раніше проксі бралось для ВСІХ магазинів
// автоматично, і коли пул Webshare тимчасово впав, це поклало заодно й
// GRO/Jabko/Yablyka/JustBuy, яким проксі не потрібен). Той самий прапор
// (14.07) тепер вмикає проксі і для Puppeteer-фолбеку нижче — див.
// getProxyBrowser() у common.js.
//
// usePuppeteerFallback: true (14.07, було false) — стара причина вимкнення
// (датацентр-проксі, 403 на кожній спробі й для fetch, і для Puppeteer)
// більше не діє: проксі-пул замінено на резидентний (Webshare Static
// Residential, підтверджено — реальні ISP-адреси США/Франції/Німеччини/
// Канади, не датацентр). Але й через нього голий fetch УСЕ ОДНО отримує
// HTTP 403 (перевірено на практиці, 14.07) — тобто сайт звіряє не лише
// репутацію IP, а й "відбиток" запиту (TLS/HTTP-заголовки), якого в
// простого fetch з Node.js немає, а в справжнього headless Chrome — є.
// Тому пробуємо Puppeteer через той самий резидентний проксі — можливо,
// саме "нормального" TLS/HTTP-відбитка достатньо, щоб пройти перевірку.
const config = {
        name: 'МТА',
        baseUrl: 'https://mta.ua/',
        searchUrl: (q) => `https://mta.ua/search?search=${encodeURIComponent(q)}`,
        useProxy: true,
        usePuppeteerFallback: true,
};

export function scrapeMTA(product) {
        return scrapeStore(config, product);
}
