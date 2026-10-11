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

/** Viking's regions, most specific first. The first one an itinerary carries is used. */
const REGION_PRIORITY = [
  'Alaska', 'Hawaii', 'Caribbean & Central America', 'Mediterranean', 'British Isles & Ireland',
  'Scandinavia', 'The Arctic', 'Australia & New Zealand', 'Asia', 'South America', 'North America',
  'Northern Africa & Middle East', 'Sub-Saharan Africa', 'Africa & Middle East',
  'World Cruises', 'Grand Journeys', 'Europe',
];

/** @returns {string|null} the most specific region; an unknown one passes through for normalize to report */
export function pickRegion(regions = []) {
  return REGION_PRIORITY.find((r) => regions.includes(r)) ?? regions[0] ?? null;
}

/** "Barcelona to Rome (Civitavecchia)" -> start and end. */
export function splitDirection(direction) {
  const [start, ...rest] = String(direction ?? '').split(' to ');
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
 * and lists at least one priced cabin.
 *
 * The price is the cheapest listed cabin, never the headline `lowestPrice`: on 14 of 156
 * sampled sailings the headline was below every listed cabin (16 Oct 2026: $5,999 against
 * a $6,599 veranda), and search relies on a sailing's price being one of its cabins'.
 */
export function sailingRows(itinerary, pricing, today) {
  const until = addDaysIso(today, 365);
  const { start, end } = splitDirection(itinerary.Direction);
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

    rows.push({
      externalId: s.PackageCode,
      url: `${SITE_ORIGIN}${itinerary.PageUrl.replace('/index.html', '/pricing.html')}`,
      ship: s.shipType,
      departurePort: start,
      endPort: end,
      destination: pickRegion(itinerary.Regions),
      departureDate: date,
      nights: itinerary.Days - 1,
      cabin: cheapest[0],
      price: cheapest[1],
      currency: 'CAD',
      cabinPrices,
      itinerary: itinerary.VoyageName,
      image: itinerary.Image ?? null,
      ports: cities.slice(1, -1),
    });
  }

  return rows;
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
