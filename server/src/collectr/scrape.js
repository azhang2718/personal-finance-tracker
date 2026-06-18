import * as cheerio from 'cheerio';
import { getConfig } from '../config.js';
import { getDb } from '../db/schema.js';
import { getMeta, setMeta } from '../db/repository.js';

// Meta key for the user-editable Collectr share link. When set, it overrides
// COLLECTR_SHARE_URL from the environment so the link can be changed in-app.
const COLLECTR_URL_KEY = 'collectr_share_url';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// In-memory cache: { value_cents, fetchedAt }
let _cache = null;

function loadCacheFromDb() {
  const db = getDb();
  // Check if we have a collectr_cache table
  try {
    const row = db.prepare(`SELECT value_cents, fetched_at FROM collectr_cache ORDER BY fetched_at DESC LIMIT 1`).get();
    if (row) {
      _cache = { value_cents: row.value_cents, fetchedAt: new Date(row.fetched_at).getTime() };
    }
  } catch {
    // Table doesn't exist yet — create it
    db.exec(`
      CREATE TABLE IF NOT EXISTS collectr_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        value_cents INTEGER NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}

function saveToCache(valueCents) {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS collectr_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      value_cents INTEGER NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO collectr_cache (value_cents) VALUES (?)`).run(valueCents);
  _cache = { value_cents: valueCents, fetchedAt: Date.now() };
}

/**
 * Try to extract portfolio value from HTML using Cheerio.
 * Returns value in cents, or null if not found.
 */
function extractFromHtml(html) {
  // Strategy 0 (most reliable): Collectr embeds the data in its Next.js payload
  // as JSON. On getcollectr.com showcase pages the visible DOM is just a skeleton
  // until client hydration, so DOM scraping is unreliable — but the value is
  // present in the server-streamed payload:
  //   "portfolio_value":[{"price":"4401.116","insertion_date":"2026-06-17T..."}]
  // (the quotes are usually backslash-escaped inside a JS string).
  const payloadValue = extractFromCollectrPayload(html);
  if (payloadValue !== null) return payloadValue;

  const $ = cheerio.load(html);

  // Strategy 1: data attributes common in portfolio apps
  const dataAttrSelectors = [
    '[data-portfolio-value]',
    '[data-total-value]',
    '[data-estimated-value]',
    '[data-collection-value]',
  ];
  for (const sel of dataAttrSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const val = el.attr('data-portfolio-value') || el.attr('data-total-value') ||
                  el.attr('data-estimated-value') || el.attr('data-collection-value');
      if (val) {
        const parsed = parseCurrencyString(val);
        if (parsed !== null) return parsed;
      }
      // Also try text content
      const text = el.text().trim();
      const parsed = parseCurrencyString(text);
      if (parsed !== null) return parsed;
    }
  }

  // Strategy 2: common class names in portfolio header region
  const classSelectors = [
    '.portfolio-value',
    '.collection-value',
    '.estimated-value',
    '.total-value',
    '.portfolio-total',
    '[class*="portfolioValue"]',
    '[class*="collectionValue"]',
    '[class*="totalValue"]',
    '[class*="portfolio-value"]',
  ];
  for (const sel of classSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const text = el.text().trim();
      const parsed = parseCurrencyString(text);
      if (parsed !== null) return parsed;
    }
  }

  // Strategy 3: currency pattern in header/hero regions only (not full page to avoid ambiguity)
  const headerRegions = $('header, [class*="header"], [class*="hero"], main > *:first-child, h1, h2').first();
  if (headerRegions.length) {
    const text = headerRegions.text();
    const candidates = findCurrencyMatches(text);
    // Only accept if there's exactly one clear candidate (avoid ambiguity)
    if (candidates.length === 1) return candidates[0];
  }

  return null;
}

/**
 * Extract the portfolio value from Collectr's embedded Next.js JSON payload.
 * Returns value in cents, or null if not found.
 */
function extractFromCollectrPayload(html) {
  if (!html) return null;
  // The payload lives inside a JS string with escaped quotes (\"). Normalising
  // them lets one regex handle both escaped and unescaped forms.
  const normalised = html.replace(/\\"/g, '"');
  const match = normalised.match(/"portfolio_value"\s*:\s*(\[[^\]]*\])/);
  if (!match) return null;

  let entries;
  try {
    entries = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // Pick the most recent entry by insertion_date (the array may hold history).
  entries.sort((a, b) => new Date(b?.insertion_date || 0) - new Date(a?.insertion_date || 0));
  const price = parseFloat(entries[0]?.price);
  if (isNaN(price) || price < 0) return null;
  return Math.round(price * 100);
}

/**
 * Parses a currency string like "$1,234.56" or "1234.56" to cents.
 */
function parseCurrencyString(str) {
  if (!str || typeof str !== 'string') return null;
  // Remove currency symbols and whitespace
  const cleaned = str.replace(/[$,\s]/g, '').trim();
  const num = parseFloat(cleaned);
  if (isNaN(num) || num < 0) return null;
  return Math.round(num * 100);
}

function findCurrencyMatches(text) {
  const regex = /\$[\d,]+(?:\.\d{2})?/g;
  const matches = [...text.matchAll(regex)];
  return matches.map((m) => parseCurrencyString(m[0])).filter((v) => v !== null && v > 0);
}

/**
 * Fetch via Playwright (headless browser) as fallback for client-rendered pages.
 */
async function fetchWithPlaywright(url) {
  let chromium, playwright;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright is not installed — run: npm install playwright && npx playwright install chromium');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': BROWSER_UA });
    await page.goto(url, { waitUntil: 'networkidle', timeout: FETCH_TIMEOUT_MS });

    // Try selectors
    const selectors = [
      '[data-portfolio-value]', '[data-total-value]', '[data-estimated-value]',
      '.portfolio-value', '.collection-value', '.estimated-value', '.total-value',
    ];
    for (const sel of selectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        const text = await page.$eval(sel, (el) => el.textContent || el.getAttribute('data-portfolio-value') || '');
        const parsed = parseCurrencyString(text);
        if (parsed !== null) return parsed;
      } catch {
        // Selector not found, continue
      }
    }

    // Fallback: full page text
    const html = await page.content();
    return extractFromHtml(html);
  } finally {
    await browser.close();
  }
}

/**
 * Main scrape function.
 * Returns { value_cents, status: 'ok'|'stale', lastUpdated: ISO string }
 */
export async function scrapeCollectr({ force = false } = {}) {
  // Initialize cache from DB if needed
  if (_cache === null) loadCacheFromDb();

  // Return cached if fresh (unless a forced re-scrape was requested, e.g. right
  // after the share link changed).
  if (!force && _cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return {
      value_cents: _cache.value_cents,
      status: 'ok',
      lastUpdated: new Date(_cache.fetchedAt).toISOString(),
    };
  }

  const url = getCollectrUrl();

  if (!url) {
    return {
      value_cents: _cache ? _cache.value_cents : null,
      status: _cache ? 'stale' : 'error',
      lastUpdated: _cache ? new Date(_cache.fetchedAt).toISOString() : null,
      message: 'COLLECTR_SHARE_URL is not configured.',
    };
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.pow(2, attempt) * 500; // 1s, 2s
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let valueCents = null;

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': BROWSER_UA },
        });
        clearTimeout(timer);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        valueCents = extractFromHtml(html);
      } catch (fetchErr) {
        clearTimeout(timer);
        throw fetchErr;
      }

      // If Cheerio found nothing, try Playwright
      if (valueCents === null) {
        console.log('[collectr] Static fetch found no value — trying Playwright fallback');
        try {
          valueCents = await fetchWithPlaywright(url);
        } catch (pwErr) {
          console.warn('[collectr] Playwright fallback failed:', pwErr.message);
        }
      }

      if (valueCents === null) {
        throw new Error('Could not parse portfolio value from page');
      }

      saveToCache(valueCents);
      console.log(`[collectr] Scraped value: $${(valueCents / 100).toFixed(2)}`);
      return {
        value_cents: valueCents,
        status: 'ok',
        lastUpdated: new Date().toISOString(),
      };
    } catch (err) {
      lastErr = err;
      console.warn(`[collectr] Attempt ${attempt + 1} failed: ${err.message}`);
    }
  }

  // All retries failed
  console.warn('[collectr] All attempts failed, keeping last known value');

  if (_cache) {
    return {
      value_cents: _cache.value_cents,
      status: 'stale',
      lastUpdated: new Date(_cache.fetchedAt).toISOString(),
      message: `Scrape failed: ${lastErr?.message ?? 'unknown error'}`,
    };
  }

  return {
    value_cents: null,
    status: 'error',
    lastUpdated: null,
    message: `Scrape failed and no cached value available: ${lastErr?.message ?? 'unknown error'}`,
  };
}

/**
 * The effective Collectr share link: the in-app value (DB) takes precedence
 * over COLLECTR_SHARE_URL from the environment. Returns null if neither is set.
 */
export function getCollectrUrl() {
  let stored = null;
  try {
    stored = getMeta(COLLECTR_URL_KEY);
  } catch {
    // DB not ready — fall back to env.
  }
  if (stored && stored.trim() !== '') return stored.trim();
  const envUrl = getConfig().COLLECTR_SHARE_URL;
  return envUrl && envUrl.trim() !== '' ? envUrl.trim() : null;
}

/**
 * Persists a new Collectr share link (or clears it when given an empty value)
 * and invalidates the scrape cache so the next refresh uses the new link.
 */
export function setCollectrUrl(url) {
  setMeta(COLLECTR_URL_KEY, url == null ? '' : String(url).trim());
  resetCache();
}

/**
 * Resets the in-memory cache (used in tests and after the URL changes).
 */
export function resetCache() {
  _cache = null;
}
