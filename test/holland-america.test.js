import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseListing, parseShip, cheapestFare, unpack, searchUrl, name, line, shipDescriptions,
} from '../sites/holland-america.js';
import { normalizeAll } from '../normalize.js';

// Captured 2026-08-05 with country=ca, all destinations. Its prices are CAD.
const cadPayload = await readFile(
  new URL('./fixtures/holland-america-search.json', import.meta.url), 'utf8',
);

test('the adapter identifies itself', () => {
  assert.equal(name, 'holland-america');
  assert.equal(line, 'Holland America');
});

test('the adapter declares it supplies no ship descriptions', () => {
  // /cruise-ships/<name> is a client-rendered shell with no description in it.
  assert.equal(shipDescriptions, false);
  assert.equal(parseShip('<html></html>').description, '');
});

test('#@# packs a value and a code; unpack splits them', () => {
  assert.deepEqual(unpack('Westerdam#@#WE'), { value: 'Westerdam', code: 'WE' });
  assert.deepEqual(unpack('Vancouver, B.C., CA#@#YVR'), { value: 'Vancouver, B.C., CA', code: 'YVR' });
  assert.deepEqual(unpack('Whittier, Alaska, US'), { value: 'Whittier, Alaska, US', code: null });
  assert.deepEqual(unpack(undefined), { value: null, code: null });
});

test('one row per doc, with unique IDs', () => {
  const rows = parseListing(cadPayload);
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((r) => r.externalId)).size, 20);
});

test('the first row reads as the captured sailing', () => {
  assert.deepEqual(parseListing(cadPayload)[0], {
    externalId: 'W656_cruise',
    url: 'https://www.hollandamerica.com/en/us/find-a-cruise/a6n07b/w656',
    ship: 'Westerdam',
    departurePort: 'Vancouver, B.C., CA',
    destination: 'ALASKA',
    departureDate: '2026-08-16',
    nights: 7,
    tripType: 'cruise',
    cabin: 'Inside',
    price: 1124,
    currency: 'CAD',
    itinerary: '7-DAY GLACIER DISCOVERY NORTHBOUND',
    image: null,
    ports: [],
  });
});

// Prices are orientative, not for booking: take the price the site shows a visitor.
// On 2026-10-02 the site showed CA$1,323 for D733 Inside — the RESTRICTED fare.
test('the price is the cheapest public fare, never a promo code or launch price', () => {
  // Synthetic: every cheaper number on this row is one the rule must ignore.
  const doc = {
    price_USD_IN_FLEXIBLE_d: 1449,
    price_USD_IN_RESTRICTED_d: 959, // what the site shows
    price_USD_IN_anonymous_d: 1449,
    price_USD_OV_RESTRICTED_d: 0, // 0 means not available
    price_USD_SS_RESTRICTED_d: -1, // -1 means not available
    price_USD_HEP2614AK_d: 649, // promo code: a targeted offer, not shown to a visitor
    price_USD_RESTRICTED_d: 900, // a summary key without a cabin code
    launch_price_USD_IN_RESTRICTED_d: 500, // the "was" price
  };
  assert.deepEqual(cheapestFare(doc), { price: 959, currency: 'USD', cabinCode: 'IN' });
});

test('a sailing with only promo-code fares has no price', () => {
  assert.equal(cheapestFare({ price_USD_HEP2614AK_d: 649 }), null);
});

test('USD is preferred, even when another currency has a smaller number', () => {
  // Numbers in different currencies are not comparable; 900 CAD is not cheaper than 959 USD.
  const doc = { price_CAD_IN_RESTRICTED_d: 900, price_USD_IN_RESTRICTED_d: 959 };
  assert.deepEqual(cheapestFare(doc), { price: 959, currency: 'USD', cabinCode: 'IN' });
});

test('without a USD fare, any available currency is used rather than dropping the sailing', () => {
  const doc = { price_CAD_IN_RESTRICTED_d: 1323, price_CAD_OV_FLEXIBLE_d: 2068 };
  assert.deepEqual(cheapestFare(doc), { price: 1323, currency: 'CAD', cabinCode: 'IN' });
});

test('cruisetours are told apart from cruises, and an unknown type passes through', () => {
  const payload = JSON.stringify({
    response: {
      docs: [
        { cruiseId: 'W729', tourId: 'T7ADAL', cruiseType: 'LAND_FIRST', price_USD_IN_FLEXIBLE_d: 3939 },
        { cruiseId: 'W728', tourId: 'T7AD9C', cruiseType: 'SEA_FIRST', price_USD_IN_FLEXIBLE_d: 2609 },
        { cruiseId: 'W728', tourId: '', cruiseType: '', price_USD_IN_FLEXIBLE_d: 1449 },
        { cruiseId: 'X1', tourId: 'T1', cruiseType: 'RIVER_FIRST', price_USD_IN_FLEXIBLE_d: 1 },
      ],
    },
  });
  const rows = parseListing(payload);
  assert.deepEqual(rows.map((r) => r.tripType), ['cruisetour', 'cruisetour', 'cruise', 'RIVER_FIRST']);
  // One cruise sold as a cruise and as a package is two sailings, not a duplicate.
  assert.deepEqual(rows.map((r) => r.externalId), ['W729_T7ADAL', 'W728_T7AD9C', 'W728_cruise', 'X1_T1']);
});

test('without facets, the destination falls back to the raw code', () => {
  const payload = JSON.stringify({
    response: { docs: [{ cruiseId: 'A1', destinationIds: ['A'], price_USD_IN_FLEXIBLE_d: 100 }] },
  });
  assert.equal(parseListing(payload)[0].destination, 'A');
});

test('a payload without docs parses to nothing rather than throwing', () => {
  assert.deepEqual(parseListing('{}'), []);
});

test('rows normalize: unpriced sailings are dropped, every cabin label is known', () => {
  const { sailings, unrecognised } = normalizeAll(parseListing(cadPayload), {
    source: 'holland-america', line: 'Holland America',
  });
  assert.equal(sailings.length, 16); // 4 docs carry no price keys at all
  assert.deepEqual(unrecognised.filter((u) => u.field !== 'row'), []);
  assert.equal(sailings[0].destination, 'alaska');
  assert.equal(sailings[0].cabin, 'interior');
  assert.equal(sailings[0].tripType, 'cruise');
});

test('the search URL asks for Alaska, in USD, unsold, earliest first, 20 at a time', () => {
  const url = new URL(searchUrl(40));
  const p = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://www.hollandamerica.com/search/halcruisesearch');
  assert.equal(p.get('start'), '40');
  assert.equal(p.get('rows'), '20');
  assert.equal(p.get('country'), 'us');
  assert.equal(p.get('sort'), 'departDate asc,cruiseId asc,tourId asc');
  assert.deepEqual(p.getAll('fq'), [
    'departDate:[NOW/DAY+1DAY TO *]', 'destinationIds:A', 'soldOut:false',
  ]);
  // Every currency's public fares, and nothing else priced: promo-code keys end in _d
  // but not in a fare type, so these three patterns leave them out.
  assert.match(p.get('fl'), /price_\*_RESTRICTED_d,price_\*_FLEXIBLE_d,price_\*_anonymous_d/);
  assert.doesNotMatch(p.get('fl'), /launch_price/);
});

const usPayload = await readFile(
  new URL('./fixtures/holland-america-alaska-us.json', import.meta.url), 'utf8',
);
const golden = JSON.parse(
  await readFile(new URL('./fixtures/holland-america-first-row.json', import.meta.url), 'utf8'),
);

test('the USD Alaska capture matches its hand-checked first row', () => {
  assert.deepEqual(parseListing(usPayload)[0], golden);
});

test('every USD Alaska row normalizes to Alaska, in USD, with a known trip type', () => {
  const { sailings, unrecognised } = normalizeAll(parseListing(usPayload), {
    source: 'holland-america', line: 'Holland America',
  });
  assert.ok(sailings.length > 0);
  for (const s of sailings) {
    assert.equal(s.destination, 'alaska', s.id);
    assert.equal(s.currency, 'USD', s.id);
    assert.ok(['cruise', 'cruisetour'].includes(s.tripType), s.id);
  }
  assert.deepEqual(unrecognised.filter((u) => u.field !== 'row'), []);
});
