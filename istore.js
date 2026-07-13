import { scrapeStore } from './common.js';

// iStore.ua (Bitrix). Точний URL пошукової видачі не підтверджено на 100% —
// пробуємо ймовірний Bitrix-шлях /ua/search/. Сайт блокує запити з IP
// датацентрів (403).
//
// usePuppeteerFallback: false — тимчасово вимкнено (перевірено на практиці:
// навіть через пул із 10 датацентр-проксі Webshare fetch-крок стабільно
// отримує 403 на КОЖНІЙ спробі, з різних IP пулу — тобто банять не
// конкретну адресу, а весь діапазон провайдера). Puppeteer із того ж
// забаненого пулу теж не знаходив жодного реального збігу (перевірено на
// прикладі товару, який на сайті точно є), тож продовжувати спроби —
// лише марно займати дефіцитні Puppeteer-слоти, які потрібні Jabko/Yablyka.
// Повернути в true, коли з'явиться робочий (резидентний) проксі.
const config = {
    name: 'iStore',
    baseUrl: 'https://www.istore.ua/ua/',
    searchUrl: (q) => `https://www.istore.ua/ua/search/?q=${encodeURIComponent(q)}`,
    usePuppeteerFallback: false,
};

export function scrapeIStore(product) {
    return scrapeStore(config, product);
}
