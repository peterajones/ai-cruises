import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  extractItineraries, splitDirection, pickRegion, sailingRows, parseListing, name, line, shipDescriptions,
} from '../sites/viking.js';

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
  assert.deepEqual(splitDirection('Round-trip Bergen'), { start: 'Round-trip Bergen', end: null });
});

test('the most specific region wins', () => {
  assert.equal(pickRegion(['Europe', 'Mediterranean']), 'Mediterranean');
  assert.equal(pickRegion(['Europe', 'Scandinavia', 'British Isles & Ireland']), 'British Isles & Ireland');
  assert.equal(pickRegion(['Europe']), 'Europe');
  assert.equal(pickRegion(['Somewhere New']), 'Somewhere New'); // passed through; normalize reports it
});

test('one row per sailing in the next 12 months, sold out and unpriced skipped', () => {
  const rows = sailingRows(iwm, pricing, TODAY);
  assert.equal(rows.length, 52); // 58 in the window, 6 sold out or without cabins
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
  assert.equal(rows.length, 52);
  assert.deepEqual(parseListing('{}'), []);
});
