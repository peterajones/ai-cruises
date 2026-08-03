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
