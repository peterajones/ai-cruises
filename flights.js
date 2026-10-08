/**
 * Approximate airfares for a cruise, from SerpApi's Google Flights API. No AI.
 *
 * Out to the start port the day before sailing; home from the end port on the day it
 * ends. One search prices the whole trip: in the 2026-10-07 spike, a multi-city
 * search's first-leg prices were whole-trip prices. See
 * docs/superpowers/specs/2026-10-07-flights-panel-design.md.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { airportFor, airportName } from './airports.js';
import { addDays } from './normalize.js';

/** Airlines sell about 11 months ahead; a search further out finds nothing. */
export const MAX_DAYS_AHEAD = 330;

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * @param {object} sailing
 * @param {string} home - IATA code
 * @param {string} today - YYYY-MM-DD
 */
export function planFlights(sailing, home, today) {
  // Data scraped before endPort existed is treated as a round trip.
  const endPort = sailing.endPort === undefined ? sailing.departurePort : sailing.endPort;
  const start = airportFor(sailing.departurePort);
  // A null end port means the line doesn't say where the cruise ends (long Princess
  // one-ways): price the flight out, and say why the flight home is missing.
  const endKnown = endPort !== null;
  const end = endKnown ? airportFor(endPort) : null;
  if (!start) return { reason: 'no-airport', message: `No airport known for ${sailing.departurePort} yet` };
  if (endKnown && !end) return { reason: 'no-airport', message: `No airport known for ${endPort} yet` };

  const outDate = addDays(sailing.departureDate, -1);
  const homeDate = sailing.endDate ?? addDays(sailing.departureDate, sailing.nights);
  if (daysBetween(today, outDate) > MAX_DAYS_AHEAD) {
    return { reason: 'too-far', message: "Airfares aren't published this far ahead yet" };
  }

  const outbound = home === start ? null : { from: home, to: start, date: outDate };
  const inbound = !endKnown || home === end ? null : { from: end, to: home, date: homeDate };
  if (!outbound && !inbound) {
    return { reason: 'no-flights-needed', message: endKnown
      ? 'No flights needed — this cruise starts and ends at your airport'
      : "No flight needed to get there — it leaves from your airport. Where it ends isn't listed." };
  }

  const note = endKnown ? undefined : "Where this cruise ends isn't listed, so the flight home isn't priced.";
  return { route: { home, outbound, inbound }, currency: sailing.currency, ...(note && { note }) };
}

/**
 * @param {{route: object, currency: string}} plan
 * @param {string} apiKey
 * @returns {URLSearchParams}
 */
export function searchParams(plan, apiKey) {
  const { outbound, inbound } = plan.route;
  const p = { engine: 'google_flights', hl: 'en', currency: plan.currency, adults: '1' };

  if (outbound && inbound && outbound.to === inbound.from) {
    Object.assign(p, { type: '1', departure_id: outbound.from, arrival_id: outbound.to, outbound_date: outbound.date, return_date: inbound.date });
  } else if (outbound && inbound) {
    const legs = [outbound, inbound].map((l) => ({ departure_id: l.from, arrival_id: l.to, date: l.date }));
    Object.assign(p, { type: '3', multi_city_json: JSON.stringify(legs) });
  } else {
    const leg = outbound ?? inbound;
    Object.assign(p, { type: '2', departure_id: leg.from, arrival_id: leg.to, outbound_date: leg.date });
  }

  return new URLSearchParams({ ...p, api_key: apiKey });
}

/**
 * The response reduced to what the panel shows. Options are sorted by price, then by
 * departure time, so equal prices come out in a stable order.
 */
export function summarize(raw) {
  const googleFlightsUrl = raw?.search_metadata?.google_flights_url ?? null;
  if (raw?.error) {
    return /hasn't returned any results/i.test(raw.error)
      ? { reason: 'no-flights', message: 'No flights found for these dates', googleFlightsUrl }
      : { reason: 'search-error', message: raw.error };
  }

  const departs = (o) => o.flights?.[0]?.departure_airport?.time ?? '';
  const options = [...(raw.best_flights ?? []), ...(raw.other_flights ?? [])]
    .filter((o) => typeof o.price === 'number')
    .sort((a, b) => a.price - b.price || departs(a).localeCompare(departs(b)));
  if (options.length === 0) return { reason: 'no-flights', message: 'No flights found for these dates', googleFlightsUrl };

  return {
    fromPrice: options[0].price,
    options: options.slice(0, 3).map((o) => ({
      price: o.price,
      airlines: [...new Set(o.flights.map((f) => f.airline))].join(', '),
      departs: departs(o),
      stops: o.flights.length - 1,
      minutes: o.total_duration,
    })),
    googleFlightsUrl,
  };
}

const CACHE_DAYS = 3;
const TIMEOUT_MS = 30_000;
const ENDPOINT = 'https://serpapi.com/search.json';

/** Searches in progress, so two asks for one trip share a search. */
const inFlight = new Map();

const cacheKey = (plan) => {
  const { outbound: o, inbound: i } = plan.route;
  return [o?.from, o?.to, o?.date, i?.from, i?.to, i?.date, plan.currency].join('|');
};

async function readCache(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

/** Written as the sailings are: a temp file, then a rename, so a crash never leaves half a file. */
async function writeCache(file, cache) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

async function search(plan, { apiKey, fetchImpl }) {
  try {
    const res = await fetchImpl(`${ENDPOINT}?${searchParams(plan, apiKey)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return summarize(await res.json());
  } catch {
    return { reason: 'search-error', message: "Couldn't reach the flight search" };
  }
}

/**
 * Flights for a sailing, from the cache when it is fresh, otherwise one search.
 * Errors are never cached — the next ask tries again. "No flights found" is.
 */
export async function flightsFor(sailing, home, { today, apiKey, cacheFile, fetchImpl = fetch, now = Date.now() }) {
  const plan = planFlights(sailing, home, today);
  if (plan.reason) return plan;
  if (!apiKey) return { reason: 'no-key', message: "Flight search isn't set up: add SERP_API_KEY to .env" };

  // City names for the panel: "Toronto (YYZ) → Vancouver (YVR)".
  const legs = [plan.route.outbound, plan.route.inbound].filter(Boolean);
  const names = Object.fromEntries(legs.flatMap((l) => [l.from, l.to]).map((c) => [c, airportName(c)]));

  const key = cacheKey(plan);
  const cache = await readCache(cacheFile);
  const hit = cache[key];
  if (hit && now - Date.parse(hit.fetchedAt) < CACHE_DAYS * 86_400_000) {
    return { route: plan.route, names, currency: plan.currency, note: plan.note, ...hit.result, fetchedAt: hit.fetchedAt, cached: true };
  }

  if (!inFlight.has(key)) {
    inFlight.set(key, (async () => {
      const result = await search(plan, { apiKey, fetchImpl });
      const fetchedAt = new Date(now).toISOString();
      if (result.reason !== 'search-error') {
        const latest = await readCache(cacheFile);
        latest[key] = { fetchedAt, result };
        await writeCache(cacheFile, latest);
      }
      return { result, fetchedAt };
    })().finally(() => inFlight.delete(key)));
  }

  const { result, fetchedAt } = await inFlight.get(key);
  return { route: plan.route, names, currency: plan.currency, note: plan.note, ...result, fetchedAt, cached: false };
}
