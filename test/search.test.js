import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchSailings,
  hasNoConstraints,
  applyPriceDirection,
  describeFilter,
  emptyMessage,
} from '../search.js';

const sailings = [
  { line: 'Royal Caribbean', ship: 'Icon of the Seas', departurePort: 'Miami',
    destination: 'caribbean', cabin: 'balcony', nights: 7, price: 1200, departureDate: '2026-11-01' },
  { line: 'Royal Caribbean', ship: 'Jewel of the Seas', departurePort: 'Fort Lauderdale',
    destination: 'bahamas', cabin: 'interior', nights: 4, price: 334, departureDate: '2026-09-07' },
  { line: 'Royal Caribbean', ship: 'Wonder of the Seas', departurePort: 'Miami',
    destination: 'bahamas', cabin: 'suite', nights: 4, price: 3000, departureDate: '2027-01-10' },
];

test('a null field does not constrain the search', () => {
  assert.equal(searchSailings(sailings, {}).length, 3);
  assert.equal(searchSailings(sailings, { destination: 'bahamas' }).length, 2);
  assert.equal(searchSailings(sailings, { destination: 'bahamas', cabin: 'suite' }).length, 1);
});

test('price and nights bounds are inclusive on both sides', () => {
  assert.equal(searchSailings(sailings, { maxPrice: 334 }).length, 1);
  assert.equal(searchSailings(sailings, { minPrice: 1200 }).length, 2);
  assert.equal(searchSailings(sailings, { minPrice: 334, maxPrice: 1200 }).length, 2);
  assert.equal(searchSailings(sailings, { minNights: 4, maxNights: 4 }).length, 2);
});

test('dates filter as ISO strings', () => {
  assert.equal(searchSailings(sailings, { dateFrom: '2026-10-01' }).length, 2);
  assert.equal(searchSailings(sailings, { dateTo: '2026-10-01' }).length, 1);
});

// The guard against shoe-store's known failure: an all-null filter matches
// EVERYTHING, so a request we could not express would return the whole dataset
// as though it all qualified.
test('a filter that constrains nothing is recognised as such', () => {
  assert.equal(hasNoConstraints({ unrecognised: ['a Michelin restaurant'] }), true);
  assert.equal(hasNoConstraints({}), true);
  assert.equal(hasNoConstraints({ destination: 'bahamas' }), false);
  assert.equal(hasNoConstraints({ maxPrice: 800 }), false);
});

test('unrecognised: 0 is a real constraint, not an absent one', () => {
  // Guards against a truthiness check creeping in where a null check belongs.
  assert.equal(hasNoConstraints({ minPrice: 0 }), false);
  assert.equal(hasNoConstraints({ nights: 0 }), false);
});

test('an over-price is moved out of maxPrice, whatever the wording', () => {
  const wrong = { minPrice: null, maxPrice: 2000 }; // what the model actually returns
  for (const q of [
    'over $2000',
    'a cruise over $2,000',
    'more than $2,000',
    'at least $2000',
    'a balcony over $2,000 in the Caribbean',
    'starting at $2,000',
  ]) {
    const f = applyPriceDirection(q, wrong);
    assert.equal(f.minPrice, 2000, `minPrice wrong for: ${q}`);
    assert.equal(f.maxPrice, null, `maxPrice not cleared for: ${q}`);
  }
});

test('an under-price stays in maxPrice', () => {
  for (const [q, expected] of [
    ['under $800', 800],
    ['below $1,200', 1200],
    ['less than $600', 600],
    ['no more than $750', 750],
    ['cheaper than $999.50', 999.5],
  ]) {
    const f = applyPriceDirection(q, { minPrice: null, maxPrice: expected });
    assert.equal(f.maxPrice, expected, `maxPrice wrong for: ${q}`);
    assert.equal(f.minPrice, null, `minPrice polluted for: ${q}`);
  }
});

test('"k" shorthand expands to thousands', () => {
  assert.equal(applyPriceDirection('over $2k', { maxPrice: null }).minPrice, 2000);
  assert.equal(applyPriceDirection('under $1.5k', { maxPrice: null }).maxPrice, 1500);
});

test('"dollars" works without a currency symbol', () => {
  assert.equal(applyPriceDirection('more than 1500 dollars', {}).minPrice, 1500);
});

// The rule must not fire on nights — "at least 5 nights" is not a price.
test('a bare number with no currency marker is left alone', () => {
  const f = applyPriceDirection('at least 5 nights', { minPrice: null, maxPrice: null });
  assert.equal(f.minPrice, null);
  assert.equal(f.maxPrice, null);
});

test('a correct filter is passed through unchanged', () => {
  const good = { minPrice: 500, maxPrice: 900 };
  assert.deepEqual(applyPriceDirection('between $500 and $900', good), good);
});

test('the filter is never mutated in place', () => {
  const original = { minPrice: null, maxPrice: 2000 };
  applyPriceDirection('over $2000', original);
  assert.equal(original.maxPrice, 2000, 'input filter was mutated');
});

test('describeFilter reads as English', () => {
  assert.equal(
    describeFilter({ nights: 4, cabin: 'balcony', destination: 'bahamas', maxPrice: 700 }),
    '4 nights, balcony, Bahamas and under $700',
  );
  assert.equal(describeFilter({}), '');
});

test('an unmappable request is named, not silently ignored', () => {
  const msg = emptyMessage({ unrecognised: ['a Michelin restaurant'] });
  assert.match(msg, /Michelin restaurant/);
});

test('an ordinary miss gets the light message', () => {
  assert.match(emptyMessage({ destination: 'alaska' }), /Alaska cruises matched/);
  assert.match(emptyMessage({}), /Nothing matched that search/);
});
