import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  extractItineraries, splitDirection, pickRegion, sailingRows, parseListing, fetchListingPages, name, line, shipDescriptions,
  MAX_SAILINGS_PER_ITINERARY,
} from '../sites/viking.js';
import { normalizeAll } from '../normalize.js';

const searchHtml = await readFile(new URL('./fixtures/viking-search.html', import.meta.url), 'utf8');

test('the adapter identifies itself', () => {
  assert.equal(name, 'viking');
  assert.equal(line, 'Viking');
  assert.equal(shipDescriptions, false);
});

test('the itineraries are read from the model embedded in the page', () => {
  const { promoCode, itineraries } = extractItineraries(searchHtml);
  assert.equal(promoCode, 'EBS');
  // 110 on the page, 3 of them river + ocean combinations.
  assert.equal(itineraries.length, 107);
  const iwm = itineraries.find((i) => i.TcmId === 'iconic-western-mediterranean');
  assert.equal(iwm.Direction, 'Barcelona to Rome (Civitavecchia)');
  assert.equal(iwm.Days, 8);
  assert.ok(itineraries.every((i) => !(i.Regions ?? []).includes('River + Ocean Combinations')));
});

test('a page without the model yields no itineraries, not an exception', () => {
  assert.deepEqual(extractItineraries('<html><body>changed</body></html>'), { promoCode: null, itineraries: [] });
});

const pricing = JSON.parse(await readFile(
  new URL('./fixtures/viking-pricing-iconic-western-mediterranean.json', import.meta.url), 'utf8'));
const iwm = extractItineraries(searchHtml).itineraries.find((i) => i.TcmId === 'iconic-western-mediterranean');
const TODAY = '2026-10-11';

test('the direction names where the cruise starts and ends', () => {
  assert.deepEqual(splitDirection('Barcelona to Rome (Civitavecchia)'), { start: 'Barcelona', end: 'Rome (Civitavecchia)' });
  assert.deepEqual(splitDirection('Montreal, Quebec to New York City, New York'), { start: 'Montreal, Quebec', end: 'New York City, New York' });
  // A round trip starts and ends at the same port (found in the 2026-10-11 scrape).
  assert.deepEqual(splitDirection('Roundtrip Athens (Piraeus), Greece'), { start: 'Athens (Piraeus), Greece', end: 'Athens (Piraeus), Greece' });
  assert.deepEqual(splitDirection('Round-trip Bergen'), { start: 'Bergen', end: 'Bergen' });
  assert.deepEqual(splitDirection('Somewhere'), { start: 'Somewhere', end: null });
});

test('the most specific region wins', () => {
  assert.equal(pickRegion(['Europe', 'Mediterranean']), 'Mediterranean');
  assert.equal(pickRegion(['Europe', 'Scandinavia', 'British Isles & Ireland']), 'British Isles & Ireland');
  assert.equal(pickRegion(['Europe']), 'Europe');
  assert.equal(pickRegion(['Somewhere New']), 'Somewhere New'); // passed through; normalize reports it
});

test('one row per sailing in the next 12 months, sold out and unpriced skipped', () => {
  const rows = sailingRows(iwm, pricing, TODAY);
  // 58 in the window, 6 sold out or without cabins: 52 — capped at the next 10 (Peter, 2026-10-11:
  // ~35 per itinerary would make Viking ~3,700 sailings, three-quarters of the app).
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.departureDate), [...rows.map((r) => r.departureDate)].sort());
  assert.equal(new Set(rows.map((r) => r.externalId)).size, rows.length);
  assert.deepEqual(rows[0], {
    externalId: 'OMI261014',
    url: 'https://www.vikingcruisescanada.com/oceans/cruise-destinations/western-mediterranean/iconic-western-mediterranean/pricing.html?startLocation=barcelona&endLocation=rome&year=2027',
    ship: 'Viking Mira',
    departurePort: 'Barcelona',
    endPort: 'Rome (Civitavecchia)',
    destination: 'Mediterranean',
    departureDate: '2026-10-14',
    nights: 7,
    cabin: 'suite',
    price: 10199,
    currency: 'CAD',
    cabinPrices: { suite: 10199 },
    itinerary: 'Iconic Western Mediterranean',
    image: 'https://assets.viking.com/is/image/viking/Aerial-City-Duomo-Skyline-Florence:3x2-widest?wid=600&hei=400',
    ports: ['Sète', 'Marseille', 'Monte Carlo', 'Florence/Pisa (Livorno)'],
  });
  assert.ok(!rows.some((r) => r.externalId === 'OSA261017'), 'sold out 17 Oct 2026 is skipped');
});

test('the price is the cheapest listed cabin, not the headline', () => {
  // 16 Oct 2026: headline lowestPrice 5999, but the cheapest listed cabin is a $6,599 veranda.
  const r = sailingRows(iwm, pricing, TODAY).find((x) => x.externalId === 'OSE261016');
  assert.equal(r.price, 6599);
  assert.equal(r.cabin, 'veranda');
  assert.deepEqual(r.cabinPrices, { suite: 9799, veranda: 6599 });
  assert.ok(sailingRows(iwm, pricing, TODAY).every((x) => x.cabinPrices[x.cabin] === x.price));
});

test('the window: today excluded, a year ahead included', () => {
  const at = (ds) => ({ cruises: [{ DepartureDateString: ds, PackageCode: `P${ds}`, shipType: 'Viking Sea',
    soldOut: false, stateroomSummary: [{ typeName: 'veranda', lowestCruisePrice: 4000 }] }] });
  assert.equal(sailingRows(iwm, at('20261011'), TODAY).length, 0);
  assert.equal(sailingRows(iwm, at('20271011'), TODAY).length, 1);
  assert.equal(sailingRows(iwm, at('20271012'), TODAY).length, 0);
});

test('parseListing reads one itinerary-and-pricing payload', () => {
  const rows = parseListing(JSON.stringify({ itinerary: iwm, pricing, today: TODAY }));
  assert.equal(rows.length, 10);
  assert.deepEqual(parseListing('{}'), []);
});

test('every row normalizes: a known destination, both cabin types, an end port', () => {
  const { sailings, unrecognised } = normalizeAll(sailingRows(iwm, pricing, TODAY), { source: 'viking', line: 'Viking' });
  assert.equal(sailings.length, 10);
  assert.ok(sailings.every((s) => s.destination === 'mediterranean'));
  assert.deepEqual(unrecognised, []);
  assert.deepEqual(sailings.find((s) => s.id === 'viking:OSE261016').cabinPrices, { balcony: 6599, suite: 9799 });
});

test('North America itineraries map to a destination', () => {
  const { sailings } = normalizeAll([{ ...sailingRows(iwm, pricing, TODAY)[0], destination: 'North America' }], { source: 'viking', line: 'Viking' });
  assert.equal(sailings[0].destination, 'canada-new-england');
});

// A fake Puppeteer page: serves the captured search page, answers pricing requests from
// a function, and counts the requests. Tests never reach Viking.
function fakePage(answer) {
  const p = {
    posts: 0,
    goto: async () => ({ status: () => 200 }),
    content: async () => searchHtml,
    // The real call is page.evaluate(fn, path, body).
    evaluate: async (_fn, _path, body) => { p.posts += 1; return answer(body); },
  };
  return p;
}

test('the fetch POSTs one pricing request per itinerary, up to the limit', async () => {
  const page = fakePage((body) => JSON.stringify(pricing));
  const payloads = await fetchListingPages(page, { limit: 2 });
  assert.equal(page.posts, 2);
  assert.equal(payloads.length, 2);
  const first = JSON.parse(payloads[0]);
  assert.equal(first.itinerary.TcmId, 'iconic-western-mediterranean');
  assert.match(first.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('a pricing answer that is not JSON fails loudly', async () => {
  // Long enough not to read as a bot wall (detectBotWall treats under 1,000 characters of
  // text as a block), so this exercises the not-JSON path.
  const page = fakePage(() => `<html><p>${"Unexpected server response. ".repeat(60)}</p></html>`);
  await assert.rejects(fetchListingPages(page, { limit: 1 }), /iconic-western-mediterranean/);
});

test('the cap keeps the earliest sailings, after skipping sold-out ones', () => {
  const rows = sailingRows(iwm, pricing, TODAY);
  // 17 Oct 2026 is sold out; it must not use up one of the ten places.
  assert.ok(!rows.some((r) => r.externalId === 'OSA261017'));
  assert.equal(rows[0].externalId, 'OMI261014');
  assert.equal(MAX_SAILINGS_PER_ITINERARY, 10);
});

// Review finding: an itinerary's sailings run both ways. Each sailing carries its own
// cruiseDirection; the itinerary's Direction is only the first of them.
test('each sailing keeps its own direction, and its ports run the same way', () => {
  const rows = sailingRows(iwm, pricing, TODAY);
  const back = rows.find((r) => r.externalId === 'OSE261016'); // Rome (Civitavecchia) to Barcelona
  assert.equal(back.departurePort, 'Rome (Civitavecchia)');
  assert.equal(back.endPort, 'Barcelona');
  assert.deepEqual(back.ports, ['Florence/Pisa (Livorno)', 'Monte Carlo', 'Marseille', 'Sète']);
  const out = rows.find((r) => r.externalId === 'OMI261014'); // Barcelona to Rome
  assert.equal(out.departurePort, 'Barcelona');
  assert.deepEqual(out.ports, ['Sète', 'Marseille', 'Monte Carlo', 'Florence/Pisa (Livorno)']);
});
