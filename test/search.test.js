import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchSailings,
  hasNoConstraints,
  applyPriceDirection,
  currencyNote,
  describeFilter,
  emptyMessage,
  upcoming,
  localDate,
  priceFor,
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

// A sailing that has left cannot be booked. The dataset only refreshes when
// someone re-scrapes, so without this a paused project serves last month's cruises.
test('departed sailings are dropped, and one leaving today is kept', () => {
  const kept = upcoming(sailings, '2026-11-01').map((s) => s.departureDate);
  assert.deepEqual(kept, ['2026-11-01', '2027-01-10']);
  assert.equal(upcoming(sailings, '2026-09-07').length, 3);
  assert.equal(upcoming(sailings, '2027-01-11').length, 0);
});

// toISOString() is UTC: at 8pm in Toronto it already says tomorrow, which would
// hide a sailing that leaves today. The date has to be read in local time.
test('localDate reads the calendar date in local time, not UTC', () => {
  const evening = new Date(2026, 8, 29, 23, 30); // 29 Sep 2026, 11:30pm local
  assert.equal(localDate(evening), '2026-09-29');
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05'); // zero-padded
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

// The dataset spans USD (Royal Caribbean, Celebrity) and CAD (Princess), and
// searchSailings compares bare numbers. Without this guard, "under $800" silently
// mixes the two — every number looks plausible, so nothing catches it.
const mixed = [
  { id: 'rc:1', line: 'Royal Caribbean', price: 700, currency: 'USD', cabin: 'balcony' },
  { id: 'ce:1', line: 'Celebrity Cruises', price: 900, currency: 'USD', cabin: 'balcony' },
  { id: 'pr:1', line: 'Princess Cruises', price: 780, currency: 'CAD', cabin: 'balcony' },
];

test('a price filter over mixed currencies is noted, not blocked', () => {
  // Prices here are indicative, not a booking contract. The search still runs;
  // the caller is told the cut-off is approximate.
  const note = currencyNote(mixed, { maxPrice: 800 });
  assert.ok(note, 'should flag USD mixed with CAD');
  assert.deepEqual(note.currencies, ['CAD', 'USD']);
  assert.match(note.note, /CAD and USD/);
  assert.match(note.note, /approximate/i);
});

test('minPrice triggers the guard too, not just maxPrice', () => {
  assert.ok(currencyNote(mixed, { minPrice: 500 }));
});

test('no price filter means no conflict, however mixed the data', () => {
  assert.equal(currencyNote(mixed, { cabin: 'balcony' }), null);
  assert.equal(currencyNote(mixed, {}), null);
});

test('narrowing to one currency resolves it', () => {
  const usdOnly = mixed.filter((s) => s.currency === 'USD');
  assert.equal(currencyNote(usdOnly, { maxPrice: 800 }), null);
  const cadOnly = mixed.filter((s) => s.currency === 'CAD');
  assert.equal(currencyNote(cadOnly, { maxPrice: 800 }), null);
});

test('an empty candidate set is not a conflict', () => {
  assert.equal(currencyNote([], { maxPrice: 800 }), null);
});

test('the note reflects the candidates, not the survivors', () => {
  // The whole point: if the naive comparison wrongly drops every CAD sailing, the
  // surviving list is uniformly USD. Judging survivors would go silent exactly
  // when the caller most needs telling.
  const survivors = mixed.filter((s) => s.currency === 'USD' && s.price <= 800);
  assert.equal(currencyNote(survivors, { maxPrice: 800 }), null,
    'survivors alone look single-currency — this is the trap');
  assert.ok(currencyNote(mixed, { maxPrice: 800 }),
    'candidates reveal the mix, which is why the server passes those');
});

test('tripType filters, and a sailing without one counts as a cruise', () => {
  const mixed = [
    { ...sailings[0], tripType: 'cruisetour' },
    { ...sailings[1], tripType: 'cruise' },
    sailings[2], // scraped before tripType existed
  ];
  assert.equal(searchSailings(mixed, { tripType: 'cruisetour' }).length, 1);
  assert.equal(searchSailings(mixed, { tripType: 'cruise' }).length, 2);
  assert.equal(searchSailings(mixed, {}).length, 3);
});

test('asking only for cruisetours is a real constraint', () => {
  assert.equal(hasNoConstraints({ tripType: 'cruisetour' }), false);
});

test('describeFilter names the trip type', () => {
  assert.equal(describeFilter({ tripType: 'cruisetour', destination: 'alaska' }), 'cruisetours and Alaska');
  assert.equal(describeFilter({ tripType: 'cruise' }), 'cruises only');
});

// normalize.js stores an unrecognised tripType as null and reports it. "Missing"
// (old data) means cruise; "unrecognised" must not quietly become one.
test('an unrecognised tripType matches neither trip type', () => {
  const odd = [{ ...sailings[0], tripType: null }];
  assert.equal(searchSailings(odd, { tripType: 'cruise' }).length, 0);
  assert.equal(searchSailings(odd, { tripType: 'cruisetour' }).length, 0);
  assert.equal(searchSailings(odd, {}).length, 1);
});

// Which price counts for a sailing when a cabin is asked for. One rule, used by the
// server's search and by the page (which imports this same file).
const withTable = { cabin: 'interior', price: 959, cabinPrices: { interior: 959, oceanview: 1009, balcony: 1459 } };
const notListed = { cabin: 'interior', price: 1142, cabinPrices: null }; // Princess
const oldData = { cabin: 'interior', price: 959 }; // scraped before cabinPrices existed

test('priceFor: no cabin asked for means the cheapest, as before', () => {
  assert.deepEqual(priceFor(withTable, null), { price: 959, cabin: 'interior' });
  assert.deepEqual(priceFor(withTable, undefined), { price: 959, cabin: 'interior' });
});

test('priceFor: a cabin in the table is priced from the table', () => {
  assert.deepEqual(priceFor(withTable, 'balcony'), { price: 1459, cabin: 'balcony' });
});

test('priceFor: a cabin missing from the table excludes the sailing', () => {
  assert.equal(priceFor(withTable, 'suite'), null);
  assert.equal(priceFor({ cabin: 'interior', price: 959, cabinPrices: {} }, 'interior'), null);
});

test('priceFor: a not-listed table is included, without a price', () => {
  assert.deepEqual(priceFor(notListed, 'balcony'), { price: null, cabin: 'balcony', notListed: true });
});

test('priceFor: a not-listed table still prices the one cabin it does list', () => {
  assert.deepEqual(priceFor(notListed, 'interior'), { price: 1142, cabin: 'interior' });
});

test('priceFor: data without a table falls back to the cheapest-cabin rule', () => {
  assert.deepEqual(priceFor(oldData, 'interior'), { price: 959, cabin: 'interior' });
  assert.equal(priceFor(oldData, 'balcony'), null);
});

const cabinSailings = [
  { cabin: 'interior', price: 959, cabinPrices: { interior: 959, balcony: 1459 } },
  { cabin: 'interior', price: 900, cabinPrices: { interior: 900, balcony: 2400 } },
  { cabin: 'interior', price: 1142, cabinPrices: null }, // Princess: not listed
  { cabin: 'interior', price: 700, cabinPrices: { interior: 700 } }, // no balcony
];

test('a cabin search finds sailings that offer it, not just those where it is cheapest', () => {
  assert.equal(searchSailings(cabinSailings, { cabin: 'balcony' }).length, 3);
});

test('a price limit applies to the asked-for cabin, not the cheapest one', () => {
  const found = searchSailings(cabinSailings, { cabin: 'balcony', maxPrice: 2000 });
  // 1459 balcony: in. 2400 balcony (cheapest 900): out. Not listed: in. No balcony: out.
  assert.deepEqual(found.map((s) => s.price), [959, 1142]);
});

test('without a cabin, price limits still use the cheapest price', () => {
  assert.equal(searchSailings(cabinSailings, { maxPrice: 950 }).length, 2);
});

// Princess lists only its cheapest cabin, so any other cabin costs at least that much.
// Its price for the asked-for cabin is unknown — but never below the cheapest one.
test('a not-listed cabin is excluded when even the cheapest cabin is over the limit', () => {
  const princess = [{ cabin: 'interior', price: 1142, cabinPrices: null }];
  assert.equal(searchSailings(princess, { cabin: 'balcony', maxPrice: 1000 }).length, 0);
  assert.equal(searchSailings(princess, { cabin: 'balcony', maxPrice: 2000 }).length, 1);
  // A minimum cannot rule it out: the balcony could cost more than the cheapest cabin.
  assert.equal(searchSailings(princess, { cabin: 'balcony', minPrice: 5000 }).length, 1);
});
