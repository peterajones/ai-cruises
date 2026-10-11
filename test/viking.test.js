import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractItineraries, name, line, shipDescriptions } from '../sites/viking.js';

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
