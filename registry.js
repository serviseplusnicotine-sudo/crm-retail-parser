import { scrapeMTA } from './mta.js';
import { scrapeIStore } from './istore.js';
import { scrapeJabko } from './jabko.js';
import { scrapeGRO } from './gro.js';
import { scrapeYablyka } from './yablyka.js';
import { scrapeJustBuy } from './justbuy.js';

// Реєстр парсерів — ключ має збігатись зі значенням RetailStore.store у
// src/app/types.ts (UA_RETAIL_STORES / PARSED_RETAIL_STORES).
export const SCRAPERS = {
  'МТА': scrapeMTA,
  'iStore': scrapeIStore,
  'Jabko': scrapeJabko,
  'GRO': scrapeGRO,
  'Yablyka': scrapeYablyka,
  'JustBuy': scrapeJustBuy,
};

export const PARSED_STORE_NAMES = Object.keys(SCRAPERS);
