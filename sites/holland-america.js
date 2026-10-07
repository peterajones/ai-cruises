/**
 * Holland America adapter. Knows about hollandamerica.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 *
 * Reads the site's own search API (a Solr endpoint) rather than the rendered page.
 * See docs/superpowers/specs/2026-10-02-holland-america-design.md for what the
 * response looks like and why each rule below is what it is.
 */

import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

export const name = 'holland-america';
export const line = 'Holland America';

const SITE_ORIGIN = 'https://www.hollandamerica.com';
const SEARCH_URL = `${SITE_ORIGIN}/search/halcruisesearch`;
const PAGE_ROWS = 20;

/**
 * Enough for one full Alaska season. Measured 2026-10-02: the 2027 season is 715
 * sailings (138 cruises, 577 cruisetours — each cruise is sold as up to 8 land
 * packages), and the whole feed 858. A cap of 450 stopped at 25 July.
 */
const CAP = 750;

// cruiseId and tourId break ties within a date, so the order is the same on every
// request and a page boundary never repeats or skips a sailing.
const SORT = 'departDate asc,cruiseId asc,tourId asc';
const FILTERS = ['departDate:[NOW/DAY+1DAY TO *]', 'destinationIds:A', 'soldOut:false'];
const FIELDS = [
  'cruiseId', 'tourId', 'itineraryId', 'shipName', 'embarkPortName', 'departDate',
  'duration', 'name', 'cruiseType', 'destinationIds', 'contentPath', 'meta',
  // Not in the site's own search query, so easy to miss: the API returns only what
  // is asked for, and these two hold the card's picture and its ports of call.
  'cruiseOverviewImage', 'portImages',
  // Every currency's public fares. Promo-code keys (price_USD_HEP2614AK_d) end in _d
  // but not in a fare type, so these leave out ~600 of them per sailing.
  'price_*_RESTRICTED_d', 'price_*_FLEXIBLE_d', 'price_*_anonymous_d',
].join(',');

/**
 * @param {number} start - zero-based row offset
 * @returns {string}
 */
export function searchUrl(start) {
  const params = new URLSearchParams({
    start: String(start), rows: String(PAGE_ROWS), country: 'us', language: 'en', sort: SORT,
  });
  for (const fq of FILTERS) params.append('fq', fq);
  params.set('fl', FIELDS);
  return `${SEARCH_URL}?${params}`;
}

/**
 * The API packs two values into one string: "Westerdam#@#WE" is a ship name and
 * its code. Split on the marker; a regex around it would break on the first name
 * that contains a character the regex did not expect.
 *
 * @param {string} packed
 * @returns {{value: string|null, code: string|null}}
 */
export function unpack(packed) {
  const [value, code = null] = String(packed ?? '').split('#@#');
  return { value: value.trim() || null, code };
}

// price_<currency>_<two-letter cabin code>_<fare type>_d. The pattern is the rule:
// it takes the public fares a visitor sees, and excludes every promo-code key
// (price_USD_HEP2614AK_d — targeted offers), the cabinless summary keys
// (price_USD_RESTRICTED_d), and launch_price_*, which is the "was" price.
const PUBLIC_FARE = /^price_([A-Z]{3})_([A-Z]{2})_(?:RESTRICTED|FLEXIBLE|anonymous)_d$/;

/**
 * The cheapest public fare on a sailing — the price the site shows. Prices here are
 * orientative, for inspiration rather than booking, so any fare type counts. -1 and
 * 0 mean "not available".
 *
 * USD when the sailing has it; otherwise whatever currency it does have, rather than
 * dropping the sailing. Numbers are only compared within one currency: 900 CAD is not
 * cheaper than 959 USD.
 *
 * @param {object} doc - one row of response.docs
 * @returns {{price: number, currency: string, cabinCode: string}|null}
 */
export function cheapestFare(doc) {
  const byCurrency = {};
  for (const [key, value] of Object.entries(doc)) {
    const match = key.match(PUBLIC_FARE);
    if (!match || typeof value !== 'number' || value <= 0) continue;
    const [, currency, cabinCode] = match;
    const best = byCurrency[currency];
    if (!best || value < best.price) byCurrency[currency] = { price: value, currency, cabinCode };
  }
  return byCurrency.USD ?? Object.values(byCurrency)[0] ?? null;
}

/**
 * The cheapest public fare for each cabin code, in one currency — the one
 * cheapestFare chose, so the table and the headline price never mix currencies.
 *
 * @param {object} doc
 * @param {string} currency
 * @returns {object} cabin code -> price
 */
export function cabinFares(doc, currency) {
  const fares = {};
  for (const [key, value] of Object.entries(doc)) {
    const match = key.match(PUBLIC_FARE);
    if (!match || match[1] !== currency || typeof value !== 'number' || value <= 0) continue;
    const cabinCode = match[2];
    if (fares[cabinCode] === undefined || value < fares[cabinCode]) fares[cabinCode] = value;
  }
  return fares;
}

/**
 * The overview photo as an absolute URL, 600px wide. The site's image server honours
 * ?imwidth, which takes this photo from 190 KB to 43 KB for a ~290px card.
 */
function overviewImage(path) {
  if (!path) return null;
  const url = /^https?:\/\//.test(path) ? path : `${SITE_ORIGIN}${path}`;
  return `${url}?imwidth=600`;
}

/**
 * Ports of call from portImages ("Juneau, Alaska, US#@#/image.jpg#@#"), without the
 * first and last entries — where the cruise starts and ends — and shortened to the
 * place name, as the other lines' cards show them.
 */
function portsOfCall(portImages) {
  const names = (portImages ?? []).map((entry) => unpack(entry).value?.split(',')[0].trim()).filter(Boolean);
  return [...new Set(names.slice(1, -1))];
}

/** "Inside#@#WE_IN" -> { IN: 'Inside' }: the site's own name for each cabin code. */
function cabinLabels(meta) {
  const labels = {};
  for (const entry of meta ?? []) {
    const { value, code } = unpack(entry);
    const cabinCode = code?.split('_').pop();
    if (value && cabinCode) labels[cabinCode] = value;
  }
  return labels;
}

/** "ALASKA#@#A" -> { A: 'ALASKA' }, from the facets in the same response. */
function destinationNames(facets) {
  const names = {};
  for (const bucket of facets?.destinations?.buckets ?? []) {
    const { value, code } = unpack(bucket.val);
    if (value && code) names[code] = value;
  }
  return names;
}

/**
 * A cruisetour is a cruise plus land days sold as one package. Anything other than
 * the three values seen is passed through raw, so normalize.js reports it.
 */
function tripTypeOf(cruiseType) {
  if (!cruiseType) return 'cruise';
  if (cruiseType === 'LAND_FIRST' || cruiseType === 'SEA_FIRST') return 'cruisetour';
  return cruiseType;
}

/**
 * @param {string} payload - raw JSON text of one halcruisesearch response
 * @returns {object[]} RawSailing rows, one per doc
 */
export function parseListing(payload) {
  const data = JSON.parse(payload);
  const docs = data?.response?.docs;
  if (!Array.isArray(docs)) return [];

  const destinations = destinationNames(data.facets);
  const rows = [];

  for (const doc of docs) {
    const fare = cheapestFare(doc);
    const labels = cabinLabels(doc.meta);
    // Keyed by the site's cabin names, which normalize.js maps to cabin types.
    const cabinPrices = fare
      ? Object.fromEntries(
          Object.entries(cabinFares(doc, fare.currency))
            .map(([code, price]) => [labels[code] ?? code, price]),
        )
      : undefined;
    const destinationCode = doc.destinationIds?.[0] ?? null;

    rows.push({
      // One cruise on one date is sold as several cruisetour packages, each with its
      // own price and page — cruiseId alone would merge them.
      externalId: `${doc.cruiseId}_${doc.tourId || 'cruise'}`,
      url: doc.contentPath ? `${SITE_ORIGIN}/en/us${doc.contentPath}` : null,
      ship: unpack(doc.shipName).value,
      departurePort: unpack(doc.embarkPortName).value,
      // A missing facets table leaves the raw code, which normalize.js reports.
      destination: destinations[destinationCode] ?? destinationCode,
      departureDate: doc.departDate ? doc.departDate.slice(0, 10) : null,
      // For a cruisetour this is the whole package, land days included.
      nights: doc.duration ?? null,
      tripType: tripTypeOf(doc.cruiseType),
      cabin: fare ? (labels[fare.cabinCode] ?? fare.cabinCode) : null,
      price: fare?.price ?? null,
      currency: fare?.currency ?? null,
      cabinPrices,
      itinerary: doc.name ?? null,
      image: overviewImage(doc.cruiseOverviewImage),
      ports: portsOfCall(doc.portImages),
    });
  }

  return rows;
}

/**
 * Pages through the search API until the cap, the limit, or a short page.
 *
 * @param {import('puppeteer').Page} page
 * @param {{limit: number}} options - caps rows fetched, below CAP
 * @returns {Promise<string[]>} raw JSON text, one per page
 */
export async function fetchListingPages(page, { limit }) {
  const wanted = Math.min(CAP, Number.isFinite(limit) ? limit : CAP);
  const payloads = [];

  for (let start = 0; start < wanted; start += PAGE_ROWS) {
    const url = searchUrl(start);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const body = await response.text();

    const wall = detectBotWall(body);
    if (wall) throw new BotWallError(wall, url);

    // Only a complete page may end the loop. An error or a partial page that ended it
    // quietly would write half the sailings and still exit 0.
    if (response.status() >= 400) throw new Error(`HTTP ${response.status()} from ${url}`);
    const data = JSON.parse(body);
    if (!Array.isArray(data?.response?.docs)) throw new Error(`no response.docs in ${url}`);
    if (data.responseHeader?.partialResults) {
      throw new Error(`partial results (the query ran out of time) from ${url}`);
    }
    payloads.push(body);

    if (data.response.docs.length < PAGE_ROWS) break;
    await politeDelay();
  }

  return payloads;
}

/**
 * Never called by scrape.js (shipDescriptions is false); kept so the adapter
 * satisfies the contract, and as the starting point if a usable page is found.
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
 * Ship pages carry no usable description: /cruise-ships/<name> is a client-rendered
 * shell, and the only server-rendered text (a deck-plans tab) describes deck plans,
 * not the ship. A missing description is visible; a wrong one is not.
 *
 * @returns {{line: string, description: string, source: null}}
 */
export function parseShip() {
  return { line, description: '', source: null };
}

/** Tells scrape.js not to fetch ship pages at all, for the reason above. */
export const shipDescriptions = false;

export function shipUrl(ship) {
  const slug = String(ship).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${SITE_ORIGIN}/en/us/cruise-ships/${slug}`;
}
