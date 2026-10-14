import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  name, line, shipDescriptions, inWindow, itineraryName, portsOf, pickDestination, parseListing,
  cabinPricesFrom,
} from '../sites/cunard.js';
import { normalizeAll } from '../normalize.js';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const search = fx('cunard-search.json');
const details = fx('cunard-details.json').data.cruiseList.items;
const priceM626C = fx('cunard-price-M626C.json');
const priceH627 = fx('cunard-price-H627.json');
const TODAY = '2026-10-14';
const payload = ({ results = search.searchResults, items = details, prices = {}, today = TODAY } = {}) =>
  JSON.stringify({ results, details: items, prices, today });

test('the adapter identifies itself', () => {
  assert.equal(name, 'cunard');
  assert.equal(line, 'Cunard');
  assert.equal(shipDescriptions, false);
});

test('the window is after today, up to a year ahead', () => {
  assert.equal(inWindow('2026-10-14', TODAY), false);
  assert.equal(inWindow('2026-10-15', TODAY), true);
  assert.equal(inWindow('2027-10-14', TODAY), true);
  assert.equal(inWindow('2027-10-15', TODAY), false);
  assert.equal(inWindow('', TODAY), false);
});

test('the itinerary name loses its trailing night count', () => {
  assert.equal(itineraryName('Southampton To Hamburg, 2 Nights'), 'Southampton To Hamburg');
  assert.equal(itineraryName('Roundtrip Transatlantic Crossing, 18 Nights'), 'Roundtrip Transatlantic Crossing');
  assert.equal(itineraryName('Abbey Road At Sea'), 'Abbey Road At Sea');
});

test('ports drop days at sea, repeated days, and the first and last port', () => {
  const names = { NYC: 'New York, NY, USA', SOU: 'Southampton (tours to London)', RTM: 'Rotterdam, Netherlands' };
  assert.deepEqual(
    portsOf(['NYC', 'ATSEADAY', 'SOU', 'ATSEADAY', 'RTM', 'RTM', 'SOU', 'ATSEADAY', 'NYC'], names),
    ['Southampton (tours to London)', 'Rotterdam, Netherlands', 'Southampton (tours to London)'],
  );
  assert.deepEqual(portsOf(['SOU', 'ATSEADAY', 'HAM'], names), []);
  // A code with no name is dropped, not shown as a code.
  assert.deepEqual(portsOf(['SOU', 'XXX', 'RTM', 'NYC'], names), ['Rotterdam, Netherlands']);
});

test('a real region beats Short-Break', () => {
  assert.equal(pickDestination(['Short-Break']), 'Short-Break');
  assert.equal(pickDestination(['Short-Break', 'Northern-Europe']), 'Northern-Europe');
  assert.equal(pickDestination(['Transatlantic']), 'Transatlantic');
  assert.equal(pickDestination([]), null);
});

test('a search page and its details become one row per sailing', () => {
  const rows = parseListing(payload());
  assert.equal(rows.length, 10);
  const m626c = rows.find((r) => r.externalId === 'M626C');
  assert.deepEqual(m626c, {
    externalId: 'M626C',
    url: 'https://www.cunard.com/en-us/find-a-cruise/M626C/M626C',
    ship: 'Queen Mary 2',
    departurePort: 'Southampton (tours to London)',
    endPort: 'Hamburg, Germany',
    destination: 'Short-Break',
    departureDate: '2026-10-18',
    nights: 2,
    cabin: 'interior',
    price: 504.74,
    currency: 'CAD',
    cabinPrices: null,
    itinerary: 'Southampton To Hamburg',
    image: 'https://www.cunard.com/dam/inventory-assets/itineraries/M626C/M626C/M626C_Hamburg_2048x1536.jpg?imwidth=600',
    ports: [],
  });
  const h627 = rows.find((r) => r.externalId === 'H627');
  assert.equal(h627.ship, 'Queen Anne');
  assert.deepEqual(h627.ports, ['Getxo (Tours To Bilbao), Spain', 'Santander, Spain', 'Gijon, Spain', 'Cherbourg, France']);
  // Without a price answer, the search's cheapest cabin is the price: M627C's is a balcony.
  const m627c = rows.find((r) => r.externalId === 'M627C');
  assert.equal(m627c.cabin, 'balcony');
  assert.equal(m627c.price, 4023.93);
  assert.deepEqual(m627c.ports, ['New York, NY, USA']);
});

test('sailings outside the window, sold out, or unpriced are skipped', () => {
  const [a, b, c, d] = search.searchResults;
  const rows = parseListing(payload({
    results: [
      { ...a, departDate: `${TODAY}T00:00:00Z` },
      { ...b, isSoldOut: true },
      { ...c, minimumPrice: 0 },
      d,
    ],
  }));
  assert.deepEqual(rows.map((r) => r.externalId), [d.cruiseId]);
});

test('a sailing missing from the details answer has no ship, and normalize drops it', () => {
  const rows = parseListing(payload({ items: details.filter((i) => i.id !== 'M626C') }));
  const m626c = rows.find((r) => r.externalId === 'M626C');
  assert.equal(m626c.ship, null);
  const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
  assert.equal(sailings.some((s) => s.id.endsWith('M626C')), false);
  assert.ok(unrecognised.some((u) => u.field === 'row' && u.raw.includes('M626C')));
});

test('a payload without results yields no rows', () => {
  assert.deepEqual(parseListing(JSON.stringify({ today: TODAY })), []);
});

test('room types become our cabins: cheapest per cabin, zeros dropped', () => {
  assert.deepEqual(cabinPricesFrom(priceM626C), {
    interior: 504.74, oceanview: 586.81, balcony: 587.2, suite: 1134.39,
  });
  assert.deepEqual(cabinPricesFrom(priceH627), { interior: 1285.67 });
  assert.equal(cabinPricesFrom(null), null);
  assert.equal(cabinPricesFrom({ errors: [{ code: '5007' }] }), null);
});

test('an unknown room-type code is keyed by its name, for normalize to map or report', () => {
  const answer = { data: { roomTypes: [
    { id: 'BI', name: 'Inside', lowestPrice: { price: 500 } },
    { id: 'ZZ', name: 'Sky Loft', lowestPrice: { price: 900 } },
  ] } };
  assert.deepEqual(cabinPricesFrom(answer), { interior: 500, 'Sky Loft': 900 });
  const [row] = parseListing(payload({ results: [search.searchResults[0]], prices: { M626C: answer } }));
  const { sailings, unrecognised } = normalizeAll([row], { source: name, line });
  assert.deepEqual(sailings[0].cabinPrices, { interior: 500 });
  assert.ok(unrecognised.some((u) => u.field === 'cabin' && u.raw === 'Sky Loft'));
});

test('a sailing with a price answer is priced per cabin', () => {
  const rows = parseListing(payload({ prices: { M626C: priceM626C, H627: priceH627 } }));
  const m626c = rows.find((r) => r.externalId === 'M626C');
  assert.deepEqual(m626c.cabinPrices, { interior: 504.74, oceanview: 586.81, balcony: 587.2, suite: 1134.39 });
  assert.equal(m626c.cabin, 'interior');
  assert.equal(m626c.price, 504.74);
  assert.equal(m626c.currency, 'CAD');
  const h627 = rows.find((r) => r.externalId === 'H627');
  assert.deepEqual(h627.cabinPrices, { interior: 1285.67 });
  // No answer for the others: the search's cheapest stands, cabinPrices null.
  assert.equal(rows.find((r) => r.externalId === 'Q629').cabinPrices, null);
});

test('the price is always one of the cabins (search relies on it)', () => {
  const rows = parseListing(payload({ prices: { M626C: priceM626C, H627: priceH627 } }));
  for (const r of rows.filter((x) => x.cabinPrices)) assert.equal(r.cabinPrices[r.cabin], r.price);
});

test('a price answer with every cabin at 0 is sold out: skipped, not $0 and not the search price', () => {
  const allZero = { data: { currencyCode: 'CAD', roomTypes: priceH627.data.roomTypes.map((t) => ({ ...t, lowestPrice: { ...t.lowestPrice, price: 0 } })) } };
  const rows = parseListing(payload({ prices: { H627: allZero } }));
  assert.equal(rows.some((r) => r.externalId === 'H627'), false);
  assert.equal(rows.length, 9);
});
