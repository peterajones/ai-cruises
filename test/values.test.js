import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveValues } from '../values.js';

const sailings = [
  { line: 'Princess', ship: 'Sky Princess', departurePort: 'Fort Lauderdale',
    destination: 'caribbean-east', cabin: 'balcony', nights: 7 },
  { line: 'Princess', ship: 'Sky Princess', departurePort: 'Seattle',
    destination: 'alaska', cabin: 'interior', nights: 14 },
  { line: 'Royal Caribbean', ship: 'Icon of the Seas', departurePort: 'Miami',
    destination: 'caribbean-east', cabin: 'suite', nights: 7 },
];

test('each enumeration is unique and sorted', () => {
  const values = deriveValues(sailings);
  assert.deepEqual(values.line, ['Princess', 'Royal Caribbean']);
  assert.deepEqual(values.destination, ['alaska', 'caribbean-east']);
  assert.deepEqual(values.cabin, ['balcony', 'interior', 'suite']);
  assert.deepEqual(values.departurePort, ['Fort Lauderdale', 'Miami', 'Seattle']);
});

test('nights sorts numerically, not as strings', () => {
  const values = deriveValues([...sailings, { ...sailings[0], nights: 3 }, { ...sailings[0], nights: 21 }]);
  assert.deepEqual(values.nights, [3, 7, 14, 21]);
});

test('nulls never reach the enumeration', () => {
  const values = deriveValues([...sailings, { ...sailings[0], destination: null, cabin: null }]);
  assert.deepEqual(values.destination, ['alaska', 'caribbean-east']);
  assert.deepEqual(values.cabin, ['balcony', 'interior', 'suite']);
});

test('no sailings gives empty lists, not undefined', () => {
  assert.deepEqual(deriveValues([]), {
    line: [], destination: [], cabin: [], departurePort: [], nights: [],
  });
});
