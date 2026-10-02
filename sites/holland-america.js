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

// price_<currency>_<two-letter cabin code>_FLEXIBLE_d. The pattern is the rule:
// it excludes RESTRICTED and "anonymous" fares, every promo-code key
// (price_USD_HEP2614AK_d), the cabinless summary keys (price_USD_FLEXIBLE), and
// launch_price_*, which is the "was" price.
const FLEXIBLE_PRICE = /^price_(USD|CAD)_([A-Z]{2})_FLEXIBLE_d$/;

/**
 * The cheapest refundable fare on a sailing. -1 and 0 mean "not available".
 *
 * @param {object} doc - one row of response.docs
 * @returns {{price: number, currency: string, cabinCode: string}|null}
 */
export function cheapestFlexible(doc) {
  let best = null;
  for (const [key, value] of Object.entries(doc)) {
    const match = key.match(FLEXIBLE_PRICE);
    if (!match || typeof value !== 'number' || value <= 0) continue;
    if (!best || value < best.price) {
      best = { price: value, currency: match[1], cabinCode: match[2] };
    }
  }
  return best;
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
    const fare = cheapestFlexible(doc);
    const labels = cabinLabels(doc.meta);
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
      itinerary: doc.name ?? null,
      image: null,
      ports: [],
    });
  }

  return rows;
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
