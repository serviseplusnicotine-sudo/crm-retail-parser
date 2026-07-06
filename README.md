# CRM Retail Parser — деплой на shared-хостинг з cPanel (CloudLinux Node.js Selector)

Це окремий, самодостатній Node.js-сервіс — той самий парсер iStore/GRO/Jabko/
Yablyka/МТА/JustBuy, що й у папці `server/` основного проєкту CRM, але
винесений в окрему теку зі своїм `package.json`, щоб деплоїти незалежно
від фронтенда.

## Встановлення через cPanel

1. **Файловий менеджер** → створи нову теку поза `public_html`, наприклад
   `~/parser-api` (НЕ всередині папки сайту `it-group.shop`).
2. Заархівуй цю теку (parser-api-v2) у .zip, заливаєш через File Manager
   → Upload → обираєш zip → після завантаження ПКМ → Extract у `~/parser-api`.
3. У cPanel знайди розділ **"Setup Node.js App"** (буває також під назвою
   "Node.js Selector" залежно від панелі).
4. **Create Application**:
   - Node.js version: обери найновішу доступну (18+)
   - Application mode: Production
   - Application root: `parser-api` (тека з кроку 1)
   - Application URL: див. нижче — краще завести окремий піддомен,
     напр. `parser.it-group.shop`, і вказати саме його
   - Application startup file: `index.js`
5. Натисни **Create**. Панель створить віртуальне середовище і покаже
   кнопку **"Run NPM Install"** — натисни її (це замінює `npm install`,
   встановить express/cors/cheerio/puppeteer).
6. Після встановлення — **Restart**. Додаток має статус "Running".

## Перевірка

Відкрий у браузері (заміни на свій домен):
`https://parser.it-group.shop/api/health`

Має показати JSON зі списком магазинів. Якщо натомість помилка 502/503 —
дивись логи додатку в тій самій панелі "Setup Node.js App" (кнопка "Log").

## Якщо Puppeteer не запускається (важливо!)

На частині shared-хостингів без прав root headless Chrome (який тягне за
собою Puppeteer) не може запуститись через відсутність системних
бібліотек (libnss3, libatk, libxss1 тощо) — встановити їх без sudo
неможливо. Це видно в логах як помилка типу
`Failed to launch the browser process` / `error while loading shared libraries`.

Якщо так сталось — напиши, я переведу магазини на легший шлях без
Puppeteer (звичайний HTTP-запит без браузера). Це надійно працює для
МТА (підтверджено вручну), а для решти — гірша якість збігів, зате
запуститься на будь-якому хостингу без обмежень.

## Проксі (щоб обійти блокування за IP хостингу)

МТА і iStore повертають HTTP 403 для запитів з IP датацентру (Render/AWS/GCP
тощо) — це блокування не залежить від коду, лише від походження IP.

Якщо купиш проксі-сервіс з українськими IP (Bright Data, Smartproxy,
IPRoyal тощо), додай у Render → Environment змінну:

```
PROXY_URL=http://логін:пароль@адреса-проксі:порт
```

Після цього — Save, rebuild and deploy. Код підхопить проксі автоматично
(і для швидких fetch-запитів, і для Puppeteer) без додаткових змін.
Без цієї змінної все продовжує працювати як є, просто без проксі.

## Підключення до сайту CRM

У самому CRM: Налаштування → «Сервер парсера роздрібних цін» → встав
`https://parser.it-group.shop` (без `/api/health` в кінці) → Зберегти.
