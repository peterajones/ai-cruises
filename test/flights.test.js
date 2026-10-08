import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFlights, searchParams, summarize, flightsFor, MAX_DAYS_AHEAD } from '../flights.js';

const multicity = JSON.parse(await readFile(new URL('./fixtures/serpapi-multicity.json', import.meta.url), 'utf8'));

// The spike's sailing: Westerdam, Vancouver -> Whittier, 9-16 May 2027.
const westerdam = {
  departurePort: 'Vancouver, B.C., CA', endPort: 'Whittier, Alaska, US',
  departureDate: '2027-05-09', nights: 7, endDate: '2027-05-16', currency: 'USD',
};
const TODAY = '2026-10-07';

test('a one-way cruise: into the start port the day before, home from the end port', () => {
  assert.deepEqual(planFlights(westerdam, 'YYZ', TODAY), {
    route: {
      home: 'YYZ',
      outbound: { from: 'YYZ', to: 'YVR', date: '2027-05-08' },
      inbound: { from: 'ANC', to: 'YYZ', date: '2027-05-16' },
    },
    currency: 'USD',
  });
});

test('a one-way cruise searches multi-city; a round trip searches a round trip', () => {
  const multi = searchParams(planFlights(westerdam, 'YYZ', TODAY), 'k');
  assert.equal(multi.get('type'), '3');
  assert.deepEqual(JSON.parse(multi.get('multi_city_json')), [
    { departure_id: 'YYZ', arrival_id: 'YVR', date: '2027-05-08' },
    { departure_id: 'ANC', arrival_id: 'YYZ', date: '2027-05-16' },
  ]);
  assert.equal(multi.get('currency'), 'USD');
  assert.equal(multi.get('engine'), 'google_flights');

  const seattle = { ...westerdam, departurePort: 'Seattle, Washington, US', endPort: 'Seattle, Washington, US' };
  const round = searchParams(planFlights(seattle, 'YYZ', TODAY), 'k');
  assert.equal(round.get('type'), '1');
  assert.equal(round.get('departure_id'), 'YYZ');
  assert.equal(round.get('arrival_id'), 'SEA');
  assert.equal(round.get('outbound_date'), '2027-05-08');
  assert.equal(round.get('return_date'), '2027-05-16');
});

test('data from before endPort existed is treated as a round trip', () => {
  const old = { departurePort: 'Seattle, Washington, US', departureDate: '2027-05-09', nights: 7, currency: 'USD' };
  const plan = planFlights(old, 'YYZ', TODAY);
  assert.deepEqual(plan.route.inbound, { from: 'SEA', to: 'YYZ', date: '2027-05-16' });
});

test('home at a cruise port: no flight for that leg; none at all if both', () => {
  const plan = planFlights(westerdam, 'YVR', TODAY);
  assert.equal(plan.route.outbound, null);
  const p = searchParams(plan, 'k');
  assert.equal(p.get('type'), '2');
  assert.equal(p.get('departure_id'), 'ANC');
  assert.equal(p.get('arrival_id'), 'YVR');
  assert.equal(p.get('outbound_date'), '2027-05-16');

  const seattle = { ...westerdam, departurePort: 'Seattle, Washington, US', endPort: 'Seattle, Washington, US' };
  assert.equal(planFlights(seattle, 'SEA', TODAY).reason, 'no-flights-needed');
});

test('an unknown port is refused before any search, and named', () => {
  const plan = planFlights({ ...westerdam, endPort: 'Nowhere Bay' }, 'YYZ', TODAY);
  assert.equal(plan.reason, 'no-airport');
  assert.match(plan.message, /Nowhere Bay/);
});

test('the 330-day limit is on the outbound date', () => {
  assert.equal(MAX_DAYS_AHEAD, 330);
  // 2026-10-07 + 330 days = 2027-09-02 (computed). Outbound = departure - 1.
  const at = (departureDate) => planFlights({ ...westerdam, departureDate, endDate: departureDate }, 'YYZ', '2026-10-07');
  assert.ok(at('2027-09-03').route);           // outbound 2027-09-02: day 330
  assert.equal(at('2027-09-04').reason, 'too-far'); // outbound 2027-09-03: day 331
});

test('a response is reduced to the cheapest price and the three cheapest options', () => {
  const s = summarize(multicity);
  assert.equal(s.fromPrice, 517);
  assert.deepEqual(s.options, [
    { price: 517, airlines: 'Flair Airlines', departs: '2027-05-08 07:40', stops: 0, minutes: 310 },
    { price: 543, airlines: 'Air Canada', departs: '2027-05-08 06:00', stops: 0, minutes: 304 },
    { price: 543, airlines: 'Air Canada', departs: '2027-05-08 07:00', stops: 0, minutes: 304 },
  ]);
  assert.match(s.googleFlightsUrl, /^https:\/\/www\.google\.com\/travel\/flights/);
});

test('"no results" and other errors become a reason and a message', () => {
  const none = summarize({ error: "Google Flights hasn't returned any results for this query." });
  assert.equal(none.reason, 'no-flights');
  assert.equal(none.message, 'No flights found for these dates');
  const quota = summarize({ error: 'Your account has run out of searches.' });
  assert.equal(quota.reason, 'search-error');
  assert.equal(quota.message, 'Your account has run out of searches.');
});

const roundtrip = JSON.parse(await readFile(new URL('./fixtures/serpapi-roundtrip.json', import.meta.url), 'utf8'));

test('a round-trip response reduces the same way', () => {
  const s = summarize(roundtrip);
  const prices = [...(roundtrip.best_flights ?? []), ...(roundtrip.other_flights ?? [])].map((o) => o.price);
  assert.equal(s.fromPrice, Math.min(...prices));
  assert.equal(s.options.length, 3);
  assert.ok(s.options.every((o, i, all) => i === 0 || all[i - 1].price <= o.price));
});

// A fake fetch: counts calls, returns a saved response. Tests never reach SerpApi.
function fakeFetch(body) {
  const f = async () => { f.calls += 1; return { json: async () => body }; };
  f.calls = 0;
  return f;
}
const opts = async (fetchImpl, extra = {}) => ({
  today: TODAY, apiKey: 'test-key', fetchImpl,
  cacheFile: join(await mkdtemp(join(tmpdir(), 'flights-')), 'cache.json'), ...extra,
});

test('a search is cached: the second ask is free', async () => {
  const f = fakeFetch(multicity); const o = await opts(f);
  const first = await flightsFor(westerdam, 'YYZ', o);
  const second = await flightsFor(westerdam, 'YYZ', o);
  assert.equal(f.calls, 1);
  assert.equal(first.fromPrice, 517);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.fromPrice, 517);
  assert.deepEqual(first.names, { YYZ: 'Toronto', YVR: 'Vancouver', ANC: 'Anchorage' });
});

test('a cached result older than three days is searched again', async () => {
  const f = fakeFetch(multicity); const o = await opts(f);
  await flightsFor(westerdam, 'YYZ', { ...o, now: Date.parse('2026-10-07T12:00:00Z') });
  await flightsFor(westerdam, 'YYZ', { ...o, now: Date.parse('2026-10-10T11:00:00Z') });
  assert.equal(f.calls, 1, 'under three days: cached');
  await flightsFor(westerdam, 'YYZ', { ...o, now: Date.parse('2026-10-10T13:00:00Z') });
  assert.equal(f.calls, 2, 'over three days: searched again');
});

test('two asks for the same trip at once make one search', async () => {
  const f = fakeFetch(multicity); const o = await opts(f);
  await Promise.all([flightsFor(westerdam, 'YYZ', o), flightsFor(westerdam, 'YYZ', o)]);
  assert.equal(f.calls, 1);
});

test('an error is shown and not cached, so the next ask tries again', async () => {
  const f = fakeFetch({ error: 'Your account has run out of searches.' }); const o = await opts(f);
  const r = await flightsFor(westerdam, 'YYZ', o);
  assert.equal(r.reason, 'search-error');
  await flightsFor(westerdam, 'YYZ', o);
  assert.equal(f.calls, 2);
});

test('no key, or a refused plan, spends nothing', async () => {
  const f = fakeFetch(multicity);
  assert.equal((await flightsFor(westerdam, 'YYZ', await opts(f, { apiKey: undefined }))).reason, 'no-key');
  assert.equal((await flightsFor({ ...westerdam, endPort: 'Nowhere Bay' }, 'YYZ', await opts(f))).reason, 'no-airport');
  assert.equal(f.calls, 0);
});

test('a network failure becomes a message', async () => {
  const failing = async () => { throw new Error('ECONNRESET'); };
  const r = await flightsFor(westerdam, 'YYZ', await opts(failing));
  assert.equal(r.reason, 'search-error');
  assert.equal(r.message, "Couldn't reach the flight search");
});
