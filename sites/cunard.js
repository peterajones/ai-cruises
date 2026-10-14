/**
 * Cunard adapter. Knows about cunard.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 *
 * Everything comes from JSON the find-a-cruise page itself uses, requested from inside
 * that page so it is same-origin: search pages of 10 sailings, one details call per page
 * (port and ship names, the photo), and one price call per sailing (each cabin's price —
 * the search carries only the cheapest). See docs/superpowers/specs/2026-10-14-cunard-design.md.
 */

import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

export const name = 'cunard';
export const line = 'Cunard';

/** Ship pages not investigated; scrape.js skips ship descriptions for this line. */
export const shipDescriptions = false;

const SITE_ORIGIN = 'https://www.cunard.com';
const AT_SEA = 'ATSEADAY';
const SHORT_BREAK = 'Short-Break';

/**
 * Cunard's room-type codes -> ours. Both styles appear, on different ships (Queen Mary 2
 * uses BI/BO/BB, Queen Anne I/O/B). Club Balcony is a balcony; both Grills are suites.
 */
export const ROOM_TYPES = {
  I: 'interior', BI: 'interior',
  O: 'oceanview', BO: 'oceanview',
  B: 'balcony', BB: 'balcony', A: 'balcony',
  S: 'suite', Q: 'suite',
};

const addDaysIso = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const dateOf = (result) => String(result?.departDate ?? '').slice(0, 10);

/** Departing after today and within a year (Peter, 2026-10-14). */
export function inWindow(date, today) {
  return Boolean(date) && date > today && date <= addDaysIso(today, 365);
}

/** "Southampton To Hamburg, 2 Nights" -> "Southampton To Hamburg": the card shows nights already. */
export function itineraryName(text) {
  return String(text ?? '').replace(/,\s*\d+\s+nights?\s*$/i, '').trim() || null;
}

/**
 * The ports between the first and the last, by name. Days at sea are dropped, and so are
 * repeated days in one port (Rotterdam, Rotterdam is an overnight stay, one call).
 */
export function portsOf(codes = [], names = {}) {
  const calls = codes
    .filter((c) => c !== AT_SEA)
    .filter((c, i, list) => i === 0 || c !== list[i - 1]);
  return calls.slice(1, -1).map((c) => names[c]).filter(Boolean);
}

/** "Short-Break" is a trip length, not a place: any real region beats it. */
export function pickDestination(ids = []) {
  return ids.find((id) => id !== SHORT_BREAK) ?? ids[0] ?? null;
}

/**
 * Each cabin's cheapest price from a price answer. A price of 0 means that cabin is not on
 * offer. An unknown code is keyed by its name ("Sky Loft"), so normalize maps it if it can
 * and reports it if not — never guessed here. Null when the answer is not a price answer.
 *
 * @param {object|null} answer - GET /api/v2/price/cruise/<id>
 * @returns {object|null}
 */
export function cabinPricesFrom(answer) {
  const types = answer?.data?.roomTypes;
  if (!Array.isArray(types)) return null;
  const table = {};
  for (const t of types) {
    const price = t.lowestPrice?.price;
    if (!(typeof price === 'number' && price > 0)) continue;
    const cabin = ROOM_TYPES[t.id] ?? t.name ?? t.id;
    if (table[cabin] === undefined || price < table[cabin]) table[cabin] = price;
  }
  return table;
}

/** The photo is 2048×1536; Cunard's image server resizes on `imwidth` (475 KB -> 100 KB). */
const smaller = (url) => (url ? `${url}${url.includes('?') ? '&' : '?'}imwidth=600` : null);

/**
 * One sailing. `detail` may be missing (the row then has no ship, and normalize drops it);
 * `priceAnswer` null means its price call failed — the search's cheapest cabin stands.
 */
export function sailingRow(result, detail, priceAnswer) {
  const names = Object.fromEntries((detail?.portsImage ?? []).map((p) => [p.id, p.txName]));
  // From the price answer when there is one: the cheapest cabin still on offer. Without
  // one (its call failed), the search's cheapest cabin stands and cabinPrices is null.
  const cabinPrices = cabinPricesFrom(priceAnswer);
  let cabin;
  let price;
  if (cabinPrices) {
    [cabin, price] = Object.entries(cabinPrices).sort((a, b) => a[1] - b[1])[0] ?? [];
  } else {
    const code = result.cabins?.[0]?.roomTypeId;
    cabin = ROOM_TYPES[code] ?? code ?? null;
    price = result.minimumPrice;
  }
  if (!(typeof price === 'number' && price > 0)) return null;

  return {
    externalId: result.cruiseId,
    url: `${SITE_ORIGIN}/en-us/find-a-cruise/${result.itineraryId}/${result.cruiseId}`,
    ship: detail?.shipId?.txName ?? null,
    departurePort: detail?.embarkPortCode?.name ?? null,
    endPort: detail?.disembarkPortCode?.name ?? null,
    destination: pickDestination(result.destinationIds),
    departureDate: dateOf(result),
    nights: result.duration,
    cabin,
    price,
    currency: priceAnswer?.data?.currencyCode ?? 'CAD',
    cabinPrices,
    itinerary: itineraryName(result.name),
    image: smaller(detail?.overviewImage?.[0]?._publishUrl),
    ports: portsOf(result.portOfCallIds, names),
  };
}

/**
 * @param {string} payload - JSON: { results, details, prices, today }, one per search page
 * @returns {object[]} RawSailing rows
 */
export function parseListing(payload) {
  const { results, details, prices, today } = JSON.parse(payload);
  if (!Array.isArray(results) || !today) return [];
  const byId = new Map((details ?? []).map((d) => [d.id, d]));
  return results
    .filter((r) => inWindow(dateOf(r), today) && !r.isSoldOut)
    .map((r) => sailingRow(r, byId.get(r.cruiseId), prices?.[r.cruiseId] ?? null))
    .filter(Boolean);
}
