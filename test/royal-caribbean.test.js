import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, parseShip, name, line } from '../sites/royal-caribbean.js';
import { normalizeAll } from '../normalize.js';

const payload = await readFile(new URL('./fixtures/royal-caribbean-listing.json', import.meta.url), 'utf8');
const shipHtml = await readFile(new URL('./fixtures/royal-caribbean-ship.html', import.meta.url), 'utf8');
const golden = JSON.parse(
  await readFile(new URL('./fixtures/royal-caribbean-first-row.json', import.meta.url), 'utf8'),
);

test('the adapter identifies itself', () => {
  assert.equal(name, 'royal-caribbean');
  assert.equal(line, 'Royal Caribbean');
});

test('parses exactly 204 sailings from the real fixture', () => {
  assert.equal(parseListing(payload).length, 204);
});

const REQUIRED_FIELDS = [
  'externalId',
  'ship',
  'departurePort',
  'destination',
  'departureDate',
  'nights',
  'cabin',
  'price',
  'currency',
];

test('every row has all required fields non-empty', () => {
  const rows = parseListing(payload);
  for (const row of rows) {
    for (const field of REQUIRED_FIELDS) {
      const value = row[field];
      const populated = value !== undefined && value !== null && value !== '';
      assert.ok(populated, `row ${JSON.stringify(row)} is missing field "${field}"`);
    }
  }
});

test('external IDs are unique across all 204 rows', () => {
  const ids = parseListing(payload).map((r) => r.externalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate externalId values found');
});

test('every departureDate is an ISO date', () => {
  const rows = parseListing(payload);
  for (const row of rows) {
    assert.match(row.departureDate, /^\d{4}-\d{2}-\d{2}$/, `bad departureDate in row: ${JSON.stringify(row)}`);
  }
});

test('every url is absolute against royalcaribbean.com', () => {
  const rows = parseListing(payload);
  for (const row of rows) {
    assert.ok(
      row.url.startsWith('https://www.royalcaribbean.com'),
      `bad url in row: ${JSON.stringify(row)}`,
    );
  }
});

test('the first row matches the hand-written golden row', () => {
  assert.deepEqual(parseListing(payload)[0], golden);
});

test('picks the cheapest tier, not the first non-null tier', () => {
  // Verified directly against the raw fixture: sailing WN4BH463_2028-01-10 has
  // stateroomClassPricing [INTERIOR 581.55, OUTSIDE 621.55, BALCONY 572.01,
  // DELUXE 1264.55] — INTERIOR is first-non-null but BALCONY is the true minimum.
  // A reduce-based minimum and a "take the first non-null tier" bug both pass
  // every other assertion in this file (the golden row's cheapest tier happens
  // to also be first), so this row is the one case in the fixture that tells
  // the two implementations apart.
  const row = parseListing(payload).find((r) => r.externalId === 'WN4BH463_2028-01-10');
  assert.ok(row, 'expected sailing WN4BH463_2028-01-10 to be present in the parsed output');
  assert.equal(row.cabin, 'BALCONY');
  assert.equal(row.price, 572.01);
});

test('skips a sailing whose stateroom tiers are all unpriced', () => {
  // Synthetic payload — not a real capture, hand-built to exercise the
  // all-null-price skip path (sites/royal-caribbean.js:29-30), which no row
  // in the real fixture happens to hit. Shaped like the real GraphQL response
  // but trimmed to only the fields parseListing reads.
  const syntheticPayload = JSON.stringify({
    data: {
      cruiseSearch: {
        results: {
          cruises: [
            {
              masterSailing: {
                itinerary: {
                  ship: { name: 'Synthetic Ship' },
                  departurePort: { name: 'Synthetic Port' },
                  destination: { name: 'Synthetic Sea' },
                  sailingNights: 5,
                },
              },
              sailings: [
                {
                  id: 'SYNTHETIC-ALL-NULL',
                  sailDate: '2030-01-01',
                  bookingLink: '/booking/landing?sailDate=2030-01-01',
                  stateroomClassPricing: [
                    { price: null, stateroomClass: { id: 'INTERIOR' } },
                    { price: null, stateroomClass: { id: 'OUTSIDE' } },
                  ],
                },
                {
                  id: 'SYNTHETIC-PRICED',
                  sailDate: '2030-01-08',
                  bookingLink: '/booking/landing?sailDate=2030-01-08',
                  stateroomClassPricing: [
                    { price: null, stateroomClass: { id: 'INTERIOR' } },
                    {
                      price: { value: 999.99, currency: { code: 'USD' } },
                      stateroomClass: { id: 'BALCONY' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  });

  const rows = parseListing(syntheticPayload);
  assert.equal(rows.length, 1, `expected exactly the priced sailing, got: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].externalId, 'SYNTHETIC-PRICED');
  assert.equal(rows[0].cabin, 'BALCONY');
  assert.equal(rows[0].price, 999.99);
});

test('returns an empty array instead of throwing when a sibling GraphQL operation lacks cruiseSearch', () => {
  // Synthetic payload — one of the four batched GraphQL responses that hit
  // cruises/graph on a real page load carries a completely different shape
  // (e.g. a filter/facet query). parseListing must not crash a run when it
  // is handed one of those by mistake; it should just yield no rows.
  const siblingOperationPayload = JSON.stringify({
    data: {
      someOtherOperation: {
        results: { facets: [] },
      },
    },
  });

  assert.deepEqual(parseListing(siblingOperationPayload), []);
});

test('the fixture survives normalizeAll with no dropped rows', () => {
  const rows = parseListing(payload);
  const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
  assert.equal(
    sailings.length,
    204,
    `dropped rows: ${JSON.stringify(unrecognised.filter((u) => u.field === 'row'), null, 2)}`,
  );
});

test('parses a description out of the ship page', () => {
  const ship = parseShip(shipHtml);
  assert.equal(ship.line, 'Royal Caribbean');
  assert.ok(ship.description.length > 80, `description too short: "${ship.description}"`);
});

test('the cabin table normalizes to cabin types, without unpriced classes', () => {
  const { sailings } = normalizeAll(parseListing(payload), { source: 'royal-caribbean', line: 'Royal Caribbean' });
  assert.deepEqual(sailings[0].cabinPrices, { interior: 598.16, balcony: 1028.16 });
  assert.ok(sailings.every((s) => s.cabinPrices && s.cabinPrices[s.cabin] === s.price));
});
