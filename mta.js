import { scrapeStore } from './common.js';

// МТА (mta.ua) — сайт серверно-рендерить видачу пошуку за адресою
// /search?search=... (перевірено вручну під час розробки), тому звичайно
// достатньо швидкого шляху (fetch + cheerio). Сайт блокує запити з IP
// датацентрів (403).
//
// usePuppeteerFallback: false — тимчасово вимкнено (перевірено на практиці:
// навіть через пул із 10 датацентр-проксі Webshare fetch-крок стабільно
// отримує 403 на КОЖНІЙ спробі, з різних IP пулу — тобто банять не
// конкретну адресу, а весь діапазон провайдера). Puppeteer із того ж
// забаненого пулу теж не знаходив жодного реального збігу — перевірено на
// прикладі "Garmin Instinct 3 45mm AMOLED Black", який на mta.ua точно є
// (перевірено вручну), а парсер віддавав "не знайдено" 0% по всій партії.
// Продовжувати спроби — лише марно займати дефіцитні Puppeteer-слоти, які
// потрібні Jabko/Yablyka. Повернути в true, коли з'явиться робочий
// (резидентний) проксі.
const config = {
    name: 'МТА',
    baseUrl: 'https://mta.ua/',
    searchUrl: (q) => `https://mta.ua/search?search=${encodeURIComponent(q)}`,
    usePuppeteerFallback: false,
};

export function scrapeMTA(product) {
    return scrapeStore(config, product);
}
