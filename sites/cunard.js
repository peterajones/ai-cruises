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


const SEARCH_URL = `${SITE_ORIGIN}/en-us/find-a-cruise`;
const CABINS_PARAM = 'IFt7InBhcnR5IjoyfV0='; // base64 of ' [{"party":2}]', as the site sends
const LIST_PATH = `/orchestrator/cruise-query-processor/cruisesearch/cruiselist?sort=availableCruiseList&cabins=${CABINS_PARAM}`;
const SEARCH_PATH = '/orchestrator/cruise-query-processor/cruisesearch';
const DETAILS_PATH = '/orchestrator/api/cruise/getCruiseDetails';
const PRICE_PATH = '/api/v2/price/cruise/';
const PAGE_SIZE = 10; // fixed by the site: rows and pageSize are ignored

/**
 * The search API reads `currency`, the price API `currencycode` (without it: HTTP 412,
 * "Currency Code Header is missing"). Both go on every request.
 */
const HEADERS = {
  brand: 'cunard', locale: 'en_US', country: 'CA', currency: 'CAD', currencycode: 'CAD',
  accept: 'application/json', 'content-type': 'application/json',
};

/** More failed price calls than this, and it is a block, not bad luck (spec). */
export const MAX_PRICE_FAILURE_RATE = 0.1;
/** Check the failure rate this early, so a block is not 300 slow failures. */
const EARLY_CHECK_AFTER = 20;

const localToday = () => new Date().toLocaleDateString('en-CA');

/**
 * One request from inside the page. HTML or HTTP 403 is a bot wall; anything else that is
 * not JSON fails loudly.
 *
 * @returns {Promise<{status: number, json: object}>}
 */
async function call(page, path, method = 'GET', body = undefined) {
  const { status, text } = await page.evaluate(async (p, m, h, b) => {
    const res = await fetch(p, { method: m, headers: h, body: b });
    return { status: res.status, text: await res.text() };
  }, path, method, HEADERS, body === undefined ? undefined : JSON.stringify(body));

  if (status === 403) throw new BotWallError('HTTP 403', path);
  const trimmed = String(text ?? '').trimStart();
  if (!trimmed.startsWith('{')) {
    throw new BotWallError(detectBotWall(text) ?? 'HTML where JSON was expected', path);
  }
  try {
    return { status, json: JSON.parse(trimmed) };
  } catch {
    throw new Error(`Cunard ${path} answered invalid JSON (HTTP ${status}): ${trimmed.slice(0, 80)}`);
  }
}

/** A price answer, or null if this call failed. A bot wall still throws. */
async function priceFor(page, cruiseId) {
  try {
    const { status, json } = await call(page, `${PRICE_PATH}${encodeURIComponent(cruiseId)}`);
    const ok = status < 400 && !(json.errors?.length) && Array.isArray(json.data?.roomTypes);
    return ok ? json : null;
  } catch (err) {
    if (err instanceof BotWallError) throw err;
    return null;
  }
}

function tooManyFailures(failed, priced) {
  return new Error(
    `${failed} of ${priced} Cunard price requests failed — more than ${MAX_PRICE_FAILURE_RATE * 100}%, ` +
      'so this looks like a block or a changed API, not bad luck.',
  );
}

/**
 * The find-a-cruise page, then — from inside it — the cruise IDs, search pages of 10 in
 * departure order, one details call per page, and one price call per sailing in the
 * window. Stops at the first page entirely past the window. `limit` caps sailings priced.
 *
 * @param {import('puppeteer').Page} page
 * @param {{limit: number, today?: string, pause?: () => Promise<void>}} options
 * @returns {Promise<string[]>} JSON payloads: { results, details, prices, today }
 */
export async function fetchListingPages(page, { limit, today = localToday(), pause = politeDelay }) {
  await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 90_000 });
  const html = await page.content();
  const wall = detectBotWall(html);
  if (wall) throw new BotWallError(wall, SEARCH_URL);

  await pause();
  const list = await call(page, LIST_PATH);
  const ids = list.json.availableCruiseList;
  if (list.status >= 400 || typeof ids !== 'string' || !ids) {
    throw new Error(`Cunard cruise ID list failed (HTTP ${list.status}): ${JSON.stringify(list.json).slice(0, 80)}`);
  }

  const cap = Number.isFinite(limit) ? limit : Infinity;
  const until = addDaysIso(today, 365);
  const payloads = [];
  let kept = 0;
  let priced = 0;
  let failed = 0;

  for (let start = 0; kept < cap; start += PAGE_SIZE) {
    await pause();
    const { status, json } = await call(page, SEARCH_PATH, 'POST', {
      filters: { start: String(start) }, cabins: CABINS_PARAM, availableCruiseList: ids,
    });
    if (status >= 400 || !Array.isArray(json.searchResults)) {
      throw new Error(`Cunard search page at ${start} failed (HTTP ${status}): ${JSON.stringify(json).slice(0, 80)}`);
    }
    const results = json.searchResults;
    if (results.length === 0) break;

    const wanted = results
      .filter((r) => inWindow(dateOf(r), today) && !r.isSoldOut)
      .slice(0, cap - kept);

    if (wanted.length > 0) {
      await pause();
      const detailPath = `${DETAILS_PATH}?ids=${encodeURIComponent(JSON.stringify(wanted.map((r) => r.cruiseId)))}&forceRCOne=true`;
      const det = await call(page, detailPath);
      const items = det.json?.data?.cruiseList?.items;
      if (det.status >= 400 || !Array.isArray(items)) {
        throw new Error(`Cunard details for page at ${start} failed (HTTP ${det.status}): ${JSON.stringify(det.json).slice(0, 80)}`);
      }

      const prices = {};
      for (const r of wanted) {
        await pause();
        const answer = await priceFor(page, r.cruiseId);
        priced += 1;
        if (!answer) failed += 1;
        prices[r.cruiseId] = answer;
        if (priced >= EARLY_CHECK_AFTER && failed / priced > MAX_PRICE_FAILURE_RATE) {
          throw tooManyFailures(failed, priced);
        }
      }
      kept += wanted.length;
      payloads.push(JSON.stringify({ results: wanted, details: items, prices, today }));
    }

    const pastWindow = results.every((r) => dateOf(r) > until);
    const lastPage = start + PAGE_SIZE >= (json.results ?? 0);
    if (pastWindow || lastPage) break;
  }

  if (priced > 0 && failed / priced > MAX_PRICE_FAILURE_RATE) throw tooManyFailures(failed, priced);
  if (failed > 0) {
    console.log(`cunard: ${failed} of ${priced} price requests failed; those sailings show only their cheapest cabin`);
  }
  return payloads;
}

/** Not used: shipDescriptions is false. Kept so the adapter satisfies the contract. */
export function parseShip() {
  return { line, description: '', source: null };
}

export function shipUrl(ship) {
  const slug = String(ship).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${SITE_ORIGIN}/en-us/our-ships/${slug}`;
}

export async function fetchShipPage(page, ship) {
  const url = shipUrl(ship);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await politeDelay();
  return page.content();
}
