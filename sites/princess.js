/**
 * Princess Cruises adapter. Knows about princess.com and nothing else.
 *
 * Unlike the Royal Caribbean and Celebrity adapters, this one parses the RENDERED
 * results page rather than a JSON API. That is not a preference — Princess's API
 * cannot produce a dated price. Its catalog carries dates without prices, its
 * pricing endpoint carries prices with no date field at all, and for ~9% of
 * itineraries one price maps to several sail dates with no way to tell which. The
 * rendered card carries both on one element, so the DOM is the only source that
 * answers the question.
 *
 * Prices are CANADIAN DOLLARS. `?currency=USD` and the /en-us/ path were both
 * tried and ignored — the site geolocates. Store CAD honestly; converting would
 * bake in a rate that goes stale and invent precision the source never gave.
 */

import { readFile } from 'node:fs/promises';
import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

export const name = 'princess';
export const line = 'Princess Cruises';

const SITE_ORIGIN = 'https://www.princess.com';

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "Wed, Dec 09, 2026" -> "2026-12-09". Null on anything else. */
function toIsoDate(input) {
  const m = String(input ?? '').match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${String(m[2]).padStart(2, '0')}`;
}

/** Strip tags, decode the entities that appear, collapse whitespace. */
function text(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First capture group of a pattern, as plain text, or ''. */
function grab(html, pattern) {
  return text((html.match(pattern) ?? [])[1]);
}

function absolute(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : `${SITE_ORIGIN}${url}`;
}

/**
 * @param {string} html - a rendered results page
 * @returns {object[]} RawSailing rows, one per dated departure card
 */
export function parseListing(html) {
  const doc = String(html ?? '');
  const rows = [];

  // Each result is one .coveo-result-card. Not all of them are sailings: the page
  // mixes in promo tiles ("Up to 40% Off", "FREE 3rd & 4th Guests") that carry no
  // departure. Cards without a .date-ship element are skipped, which is why a
  // 20-card page yields 15 rows.
  const cards = doc.split(/<div[^>]*class="[^"]*\bcoveo-result-card\b/).slice(1);

  for (const card of cards) {
    const dateShip = grab(card, /class="[^"]*\bdate-ship\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!dateShip.includes(' on ')) continue;

    const [rawDate, rawShip] = dateShip.split(' on ');
    const departureDate = toIsoDate(rawDate);
    const ship = rawShip?.trim();
    if (!departureDate || !ship) continue;

    // The card shows a struck-through "Was" price above the real "Now" price:
    //   <div class="... striked-price ..."><span>Was</span><span class="amount">$<s>2362</s></span></div>
    //   <div class="price align-center"><span>Now</span><span class="amount">$1,142</span></div>
    // Anchoring on the literal "Now" label is what keeps this from silently
    // reporting the higher pre-discount fare on every single sailing.
    const nowAmount = grab(card, /Now<\/span>\s*<span[^>]*class="[^"]*\bamount\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const price = Number(nowAmount.replace(/[^0-9.]/g, '')) || null;

    // The title is the anchor's text, NOT the whole .details-header div — the div
    // also contains the "Save" wishlist button, which otherwise appends to it.
    const itinerary = grab(card, /class="[^"]*\bdetails-header\b[^"]*"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const nights = Number((itinerary.match(/(\d+)\s*-?\s*Day/i) ?? [])[1]) || null;

    // Each port is its own <a class="port-link">. Splitting a flattened text blob
    // does not work: collapsing whitespace destroys the boundaries between them.
    const ports = [
      ...new Set(
        [...card.matchAll(/class="[^"]*\bport-link\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
          .map((m) => text(m[1]))
          .filter((p) => p && !/^scenic cruising/i.test(p)),
      ),
    ];

    // "Roundtrip from Singapore" is a bare text node that comes BEFORE a nested
    // promo div. Capturing to the closing </div> would swallow "Up to 40% Off".
    const portLine = grab(card, /class="[^"]*\bdetails-ports\b[^"]*"[^>]*>([^<]*)/);
    // Not every card carries a "Roundtrip from X" line (one-way sailings do not),
    // so fall back to the first port of call rather than emitting null.
    const departurePort = (portLine.split(/\bfrom\b/i)[1] ?? '').trim() || ports[0] || null;

    // The detail link carries a real per-departure identifier: ?voyageCode=M634.
    // Preferred over synthesising one from ship+date, because it is the site's own.
    const href = (card.match(/href="([^"]*itinerary-details[^"]*)"/) ?? [])[1];
    const voyage = (href?.match(/voyageCode=([A-Z0-9]+)/i) ?? [])[1];
    const img = (card.match(/<img[^>]+src="([^"]+)"/) ?? [])[1];

    rows.push({
      externalId: voyage
        ? `${voyage}_${departureDate}`
        : `${ship}_${departureDate}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      url: absolute(href),
      ship,
      departurePort,
      // Princess names no region — the itinerary title is the only signal, so the
      // whole title is handed over and normalize.js finds the region inside it.
      // Deriving from port countries was tried and is wrong in the most misleading
      // way: a Caribbean cruise leaving Fort Lauderdale reads as "Florida".
      destination: itinerary || null,
      departureDate,
      nights,
      cabin: grab(card, />([^<]*?)\s*from\*/) || null,
      price,
      currency: 'CAD',
      itinerary: itinerary || null,
      image: absolute(img),
      ports,
    });
  }

  return rows;
}

const RESULTS_URL = `${SITE_ORIGIN}/cruise-search/results/`;

/** Ship codes come from a reference table captured alongside the fixtures. */
async function shipCodes() {
  const ref = JSON.parse(
    await readFile(new URL('../test/fixtures/princess-ships-ref.json', import.meta.url), 'utf8'),
  );
  return ref.ships.map((s) => s.id);
}

export function shipUrl(ship) {
  const slug = String(ship).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${SITE_ORIGIN}/ships/${slug}`;
}

/**
 * Scrolls until the card count stops growing, then returns the rendered HTML.
 *
 * The list lazy-loads: 10 cards on arrival, 20 after a scroll. Bounded at 15
 * iterations so a site change cannot spin forever, and every scroll is spaced by
 * politeDelay.
 */
async function loadAllCards(page) {
  let previous = -1;
  for (let i = 0; i < 15; i += 1) {
    const count = await page.evaluate(
      () => document.querySelectorAll('.product-details-date-wrapper').length,
    );
    if (count === previous) break;
    previous = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await politeDelay(2500);
  }
  return page.content();
}

/**
 * One rendered results page per ship.
 *
 * @param {import('puppeteer').Page} page
 * @param {{limit: number}} options - `limit` caps how many SHIPS are visited
 *   (~20 sailings each), so a small limit means a short run rather than a full
 *   17-ship crawl.
 * @returns {Promise<string[]>}
 */
export async function fetchListingPages(page, { limit }) {
  const codes = await shipCodes();
  const wanted = Number.isFinite(limit)
    ? codes.slice(0, Math.max(1, Math.ceil(limit / 20)))
    : codes;
  const pages = [];

  for (const code of wanted) {
    const url = `${RESULTS_URL}?ship=${code}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
    await politeDelay();

    const html = await loadAllCards(page);
    const wall = detectBotWall(html);
    if (wall) throw new BotWallError(wall, url);

    pages.push(html);
  }

  return pages;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} ship
 * @returns {Promise<string>} raw HTML
 */
export async function fetchShipPage(page, ship) {
  const url = shipUrl(ship);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await politeDelay();

  const html = await page.content();
  const wall = detectBotWall(html);
  if (wall) throw new BotWallError(wall, url);

  return html;
}

/**
 * Princess ship pages are not reliably addressable, so this adapter does not
 * supply ship descriptions.
 *
 * `/ships/<slug>` 404s for most of the fleet (Sky, Majestic, Regal, Emerald,
 * Grand, Enchanted, Royal, Caribbean) and — worse — returns HTTP 200 with the
 * WRONG ship for others: /ships/discovery-princess serves Diamond Princess's
 * page, Izumi Japanese Bath and all. A missing description is visible; a
 * confidently wrong one is not, so nothing is returned rather than something
 * unverifiable.
 *
 * If a correct URL pattern is found later, restore the og:description read used
 * by the Royal Caribbean adapter.
 *
 * @returns {{line: string, description: string, source: null}}
 */
export function parseShip() {
  return { line, description: '', source: null };
}
