/**
 * Viking adapter (ocean cruises). Knows about vikingcruisescanada.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 *
 * The search page embeds its itineraries in a script; each itinerary's dated sailings
 * come from one Dates & Pricing request. See
 * docs/superpowers/specs/2026-10-11-viking-design.md.
 */

import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

export const name = 'viking';
export const line = 'Viking';

/** No usable ship pages investigated; scrape.js skips ship descriptions for this line. */
export const shipDescriptions = false;

const SITE_ORIGIN = 'https://www.vikingcruisescanada.com';
const SEARCH_URL = `${SITE_ORIGIN}/oceans/search-cruises/index.html`;
const MODEL_MARKER = 'window.app.superfac.viewModel';
const COMBINATION = 'River + Ocean Combinations';

/** The JSON object assigned after `marker = ` in a script, by brace matching. */
function embeddedObject(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && (depth -= 1) === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

/**
 * @param {string} html - the ocean search page
 * @returns {{promoCode: string|null, itineraries: object[]}}
 */
export function extractItineraries(html) {
  const model = embeddedObject(html, MODEL_MARKER);
  const value = model?.PageData?.Value;
  if (!value?.Results) return { promoCode: null, itineraries: [] };
  return {
    promoCode: value.CurrentPromoCode ?? null,
    itineraries: value.Results.filter((r) => !(r.Regions ?? []).includes(COMBINATION)),
  };
}

/**
 * Each itinerary sails ~35 times in a year; all of them would make Viking ~3,700 sailings,
 * three-quarters of the app. The next ten keep every route, nearest dates first
 * (Peter, 2026-10-11). Raise it here to take more.
 */
export const MAX_SAILINGS_PER_ITINERARY = 10;

/** Viking's regions, most specific first. The first one an itinerary carries is used. */
const REGION_PRIORITY = [
  'Alaska', 'Hawaii', 'Caribbean & Central America', 'Mediterranean', 'British Isles & Ireland',
  'Scandinavia', 'The Arctic', 'Australia & New Zealand', 'Asia', 'South America', 'North America',
  'Northern Africa & Middle East', 'Sub-Saharan Africa', 'Africa & Middle East',
  'World Cruises', 'Grand Journeys', 'Europe',
];

const BROAD = ['Europe', 'Grand Journeys', 'World Cruises'];

/**
 * The most specific region — except for voyages that cross the world: a world cruise,
 * or a grand journey spanning 3+ specific regions or longer than 60 days, is a world
 * voyage (review finding: world cruises fell to "Hawaii", a 78-night Australia-Asia-
 * Alaska voyage to "Alaska"). An unknown region passes through for normalize to report.
 *
 * @param {string[]} regions
 * @param {number} [days]
 * @returns {string|null}
 */
export function pickRegion(regions = [], days = 0) {
  if (regions.includes('World Cruises')) return 'World Cruises';
  const specific = regions.filter((r) => !BROAD.includes(r));
  if (regions.includes('Grand Journeys') && (specific.length >= 3 || days > 60)) return 'Grand Journeys';
  return REGION_PRIORITY.find((r) => regions.includes(r)) ?? regions[0] ?? null;
}

/** "Barcelona to Rome (Civitavecchia)" -> start and end; "Roundtrip Athens …" starts and ends there. */
export function splitDirection(direction) {
  const text = String(direction ?? '').trim();
  const roundtrip = text.match(/^round-?trip\s+(.+)$/i);
  if (roundtrip) return { start: roundtrip[1].trim(), end: roundtrip[1].trim() };
  const [start, ...rest] = text.split(' to ');
  return { start: start.trim() || null, end: rest.length ? rest.join(' to ').trim() : null };
}

const addDaysIso = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const isoFrom = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/**
 * One row per sailing departing after today and within a year, that is not sold out
 * and lists at least one priced cabin — the earliest MAX_SAILINGS_PER_ITINERARY of them.
 *
 * The price is the cheapest listed cabin, never the headline `lowestPrice`: on 14 of 156
 * sampled sailings the headline was below every listed cabin (16 Oct 2026: $5,999 against
 * a $6,599 veranda), and search relies on a sailing's price being one of its cabins'.
 */
export function sailingRows(itinerary, pricing, today) {
  const until = addDaysIso(today, 365);
  const headline = splitDirection(itinerary.Direction);
  const cities = itinerary.Cities ?? [];
  const rows = [];

  for (const s of pricing?.cruises ?? []) {
    const date = s.DepartureDateString ? isoFrom(s.DepartureDateString) : null;
    if (!date || date <= today || date > until || s.soldOut) continue;

    const cabinPrices = Object.fromEntries(
      (s.stateroomSummary ?? [])
        .filter((c) => typeof c.lowestCruisePrice === 'number' && c.lowestCruisePrice > 0)
        .map((c) => [c.typeName, c.lowestCruisePrice]),
    );
    const cheapest = Object.entries(cabinPrices).sort((a, b) => a[1] - b[1])[0];
    if (!cheapest) continue;

    // An itinerary's sailings run both ways (Barcelona to Rome, and Rome to Barcelona);
    // each carries its own direction. Ports follow it: a sailing that starts where the
    // itinerary ends visits them in reverse.
    const { start, end } = splitDirection(s.cruiseDirection ?? itinerary.Direction);
    const reversed = start !== headline.start && start === headline.end;
    const calls = cities.slice(1, -1);

    rows.push({
      externalId: s.PackageCode,
      url: `${SITE_ORIGIN}${itinerary.PageUrl.replace('/index.html', '/pricing.html')}`,
      ship: s.shipType,
      departurePort: start,
      endPort: end,
      destination: pickRegion(itinerary.Regions, itinerary.Days),
      departureDate: date,
      nights: itinerary.Days - 1,
      cabin: cheapest[0],
      price: cheapest[1],
      currency: 'CAD',
      cabinPrices,
      itinerary: itinerary.VoyageName,
      image: itinerary.Image ?? null,
      ports: reversed ? [...calls].reverse() : calls,
    });
  }

  return rows
    .sort((a, b) => a.departureDate.localeCompare(b.departureDate))
    .slice(0, MAX_SAILINGS_PER_ITINERARY);
}

/**
 * @param {string} payload - JSON: { itinerary, pricing, today }, one per itinerary
 * @returns {object[]} RawSailing rows
 */
export function parseListing(payload) {
  const { itinerary, pricing, today } = JSON.parse(payload);
  if (!itinerary || !pricing || !today) return [];
  return sailingRows(itinerary, pricing, today);
}


const PRICING_PATH = '/oceans/Core/DnPCruiseFullInfo?v=11';

/**
 * The search page, then one Dates & Pricing POST per itinerary, sent from inside the
 * page so it is same-origin with the site's own cookies. `limit` caps itineraries.
 *
 * @returns {Promise<string[]>} JSON payloads: { itinerary, pricing, today }
 */
export async function fetchListingPages(page, { limit, onProgress = () => {} }) {
  await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
  const html = await page.content();
  const wall = detectBotWall(html);
  if (wall) throw new BotWallError(wall, SEARCH_URL);

  const { promoCode, itineraries } = extractItineraries(html);
  const wanted = Number.isFinite(limit) ? itineraries.slice(0, limit) : itineraries;
  const today = new Date().toISOString().slice(0, 10);
  const payloads = [];

  for (const [i, itinerary] of wanted.entries()) {
    onProgress(`itinerary ${i + 1}/${wanted.length}`);
    await politeDelay();
    const body = {
      cruiseId: itinerary.TcmId,
      parameters: itinerary.PageUrl.slice(itinerary.PageUrl.indexOf('?')),
      offerCode: promoCode,
    };
    const { status, text } = await page.evaluate(async (path, b) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(b),
      });
      return { status: res.status, text: await res.text() };
    }, PRICING_PATH, body);

    const blocked = detectBotWall(text);
    if (blocked && !text.trimStart().startsWith('{')) throw new BotWallError(blocked, PRICING_PATH);
    let pricing;
    try {
      pricing = JSON.parse(text);
    } catch {
      throw new Error(`Viking pricing for ${itinerary.TcmId} was not JSON: ${text.slice(0, 80)}`);
    }
    // An error can be valid JSON too; parsing alone would drop the itinerary silently.
    const problem = status >= 400 ? `HTTP ${status}`
      : pricing.cruiseErrorFlag ? 'cruiseErrorFlag set'
        : pricing.errors?.length ? `errors: ${JSON.stringify(pricing.errors).slice(0, 80)}`
          : !Array.isArray(pricing.cruises) ? 'no cruises list' : null;
    if (problem) throw new Error(`Viking pricing for ${itinerary.TcmId} failed: ${problem}`);
    payloads.push(JSON.stringify({ itinerary, pricing, today }));
  }

  return payloads;
}

/** Not used: shipDescriptions is false. Kept so the adapter satisfies the contract. */
export function parseShip() {
  return { line, description: '', source: null };
}

export function shipUrl(ship) {
  const slug = String(ship).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${SITE_ORIGIN}/oceans/ships/${slug}.html`;
}

export async function fetchShipPage(page, ship) {
  const url = shipUrl(ship);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await politeDelay();
  return page.content();
}
