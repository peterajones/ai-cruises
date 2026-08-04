import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDestination, canonicalCabin, toIsoDate, normalizeAll } from '../normalize.js';

test('every spelling of Eastern Caribbean canonicalizes the same way', () => {
  for (const raw of ['Eastern Caribbean', 'Caribbean - Eastern', 'E. Caribbean', 'CARIBBEAN EAST']) {
    assert.equal(canonicalDestination(raw), 'caribbean-east', `failed on: ${raw}`);
  }
});

test('cabin synonyms canonicalize', () => {
  assert.equal(canonicalCabin('Inside'), 'interior');
  assert.equal(canonicalCabin('Interior Stateroom'), 'interior');
  assert.equal(canonicalCabin('Ocean View'), 'oceanview');
  assert.equal(canonicalCabin('Outside'), 'oceanview');
  assert.equal(canonicalCabin('Verandah'), 'balcony');
  assert.equal(canonicalCabin('Mini-Suite'), 'suite');
  // Royal Caribbean's GraphQL API names its top stateroom tier "DELUXE"; the
  // fixture's own stateroomClasses metadata (test/fixtures/royal-caribbean-listing.json)
  // gives every DELUXE entry a human-facing name of "Suite" and amenities text
  // ("Live the 'suite' life", superCategory "Royal Suite Class"/"Suites").
  assert.equal(canonicalCabin('DELUXE'), 'suite');
});

test('Celebrity\'s tier and region labels map', () => {
  // Evidence: Celebrity's own metadata names AQUA "Aquaclass" and DELUXE "The
  // Retreat" (its suite class); both were surfaced by the unrecognised list.
  assert.equal(canonicalCabin('AQUA'), 'balcony');
  assert.equal(canonicalCabin('Aquaclass'), 'balcony');
  assert.equal(canonicalCabin('DELUXE'), 'suite');
  assert.equal(canonicalDestination('Europe'), 'europe');
});

test('a coarse source label is not refined into a guess', () => {
  // Celebrity says "Europe" for Greek isles and Norwegian fjords alike, so it
  // must not resolve to a specific sea.
  assert.equal(canonicalDestination('Europe'), 'europe');
  assert.notEqual(canonicalDestination('Europe'), 'mediterranean');
  // Sources that ARE specific keep their precision.
  assert.equal(canonicalDestination('Norwegian Fjords'), 'northern-europe');
  assert.equal(canonicalDestination('Eastern Mediterranean'), 'mediterranean-east');
});

test('unknown values return null rather than guessing', () => {
  assert.equal(canonicalDestination('Panama Canal - Partial Transit'), null);
  assert.equal(canonicalCabin('Igloo'), null);
});

test('dates in any of the observed formats become ISO', () => {
  assert.equal(toIsoDate('2027-01-16'), '2027-01-16');
  assert.equal(toIsoDate('Jan 16, 2027'), '2027-01-16');
  assert.equal(toIsoDate('January 16, 2027'), '2027-01-16');
  assert.equal(toIsoDate('01/16/2027'), '2027-01-16');
  assert.equal(toIsoDate('sometime in spring'), null);
});

const goodRow = {
  externalId: '12345',
  url: 'https://www.princess.com/cruise/12345',
  ship: 'Sky Princess',
  departurePort: 'Fort Lauderdale',
  destination: 'Caribbean - Eastern',
  departureDate: 'Jan 16, 2027',
  nights: '7',
  cabin: 'Verandah',
  price: '$1,299',
  currency: 'USD',
};

test('a good row becomes a fully canonical Sailing', () => {
  const { sailings, unrecognised } = normalizeAll([goodRow], { source: 'princess', line: 'Princess' });
  assert.equal(unrecognised.length, 0);
  assert.deepEqual(sailings[0], {
    id: 'princess:12345',
    source: 'princess',
    url: 'https://www.princess.com/cruise/12345',
    line: 'Princess',
    ship: 'Sky Princess',
    departurePort: 'Fort Lauderdale',
    destination: 'caribbean-east',
    departureDate: '2027-01-16',
    nights: 7,
    cabin: 'balcony',
    price: 1299,
    currency: 'USD',
    itinerary: null,
    image: null,
    ports: [],
  });
});

test('an unmappable destination keeps the sailing and records the miss', () => {
  const row = { ...goodRow, destination: 'Panama Canal - Partial Transit' };
  const { sailings, unrecognised } = normalizeAll([row], { source: 'princess', line: 'Princess' });
  assert.equal(sailings.length, 1);
  assert.equal(sailings[0].destination, null);
  assert.deepEqual(unrecognised, [
    { field: 'destination', raw: 'Panama Canal - Partial Transit', count: 1 },
  ]);
});

test('misses are counted, not repeated', () => {
  const row = { ...goodRow, destination: 'Fjords of Nowhere' };
  const { unrecognised } = normalizeAll([row, { ...row, externalId: '2' }, { ...row, externalId: '3' }],
    { source: 'princess', line: 'Princess' });
  assert.deepEqual(unrecognised, [{ field: 'destination', raw: 'Fjords of Nowhere', count: 3 }]);
});

test('a row missing a required field is dropped and recorded', () => {
  const { sailings, unrecognised } = normalizeAll([{ ...goodRow, price: null }],
    { source: 'princess', line: 'Princess' });
  assert.equal(sailings.length, 0);
  assert.equal(unrecognised[0].field, 'row');
});

test('price ranges with multiple numbers are rejected as ambiguous', () => {
  const row = { ...goodRow, price: '$1,299 - $1,499' };
  const { sailings, unrecognised } = normalizeAll([row], { source: 'princess', line: 'Princess' });
  assert.equal(sailings.length, 0);
  assert.equal(unrecognised[0].field, 'row');
});

test('price with per-person and total notation is rejected', () => {
  const row = { ...goodRow, price: '$1,299 pp / $2,598 total' };
  const { sailings, unrecognised } = normalizeAll([row], { source: 'princess', line: 'Princess' });
  assert.equal(sailings.length, 0);
  assert.equal(unrecognised[0].field, 'row');
});

