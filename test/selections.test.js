import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSelections, nodeSupportsSqlite, snapshotOf, selectionMap } from '../selections.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'sel-')), 'selections.db');
const sailing = (over = {}) => ({
  id: 'cunard:M626C', line: 'Cunard', ship: 'Queen Mary 2', itinerary: 'Southampton To Hamburg',
  destination: 'europe', departureDate: '2026-10-18', nights: 2, price: 504.74, currency: 'CAD',
  cabin: 'interior', url: 'https://www.cunard.com/x', image: null, departurePort: 'Southampton',
  ports: ['ignored'], cabinPrices: { interior: 504.74 }, ...over,
});

test('Node 24.15 or later is needed', () => {
  assert.equal(nodeSupportsSqlite('22.14.0'), false);
  assert.equal(nodeSupportsSqlite('24.14.0'), false);
  assert.equal(nodeSupportsSqlite('24.15.0'), true);
  assert.equal(nodeSupportsSqlite('25.0.0'), true);
});

test('on an older Node the store is unavailable, with a reason that says what to do', async () => {
  const store = await openSelections(tmp(), { version: '22.14.0' });
  assert.equal(store.ok, false);
  assert.match(store.reason, /Node 24\.15/);
  assert.match(store.reason, /nvm use/);
});

test('a path that cannot be a database is unavailable, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sel-'));
  mkdirSync(join(dir, 'selections.db'));
  const store = await openSelections(join(dir, 'selections.db'));
  assert.equal(store.ok, false);
  assert.match(store.reason, /Could not open/);
});

test('a new database starts empty', async () => {
  const store = await openSelections(tmp());
  assert.equal(store.ok, true);
  assert.deepEqual(store.all(), []);
});

test('a view creates a row, then counts', async () => {
  const store = await openSelections(tmp());
  const first = store.recordView(sailing(), '2026-10-14T10:00:00Z');
  assert.equal(first.views, 1);
  assert.equal(first.rating, null);
  assert.equal(first.firstViewed, '2026-10-14T10:00:00Z');
  const second = store.recordView(sailing({ price: 480 }), '2026-10-15T09:00:00Z');
  assert.equal(second.views, 2);
  assert.equal(second.firstViewed, '2026-10-14T10:00:00Z');
  assert.equal(second.lastViewed, '2026-10-15T09:00:00Z');
  assert.equal(second.snapshot.price, 480, 'the snapshot is refreshed');
});

test('the snapshot keeps the card fields and nothing else', () => {
  assert.deepEqual(Object.keys(snapshotOf(sailing())).sort(), [
    'cabin', 'currency', 'departureDate', 'departurePort', 'destination', 'id', 'image',
    'itinerary', 'line', 'nights', 'price', 'ship', 'url',
  ]);
});

test('rate, change, and clear a rating', async () => {
  const store = await openSelections(tmp());
  assert.equal(store.setRating('cunard:M626C', 4, 'T1', sailing()).rating, 4);
  const changed = store.setRating('cunard:M626C', 2, 'T2', sailing());
  assert.equal(changed.rating, 2);
  assert.equal(changed.ratedAt, 'T2');
  // Never viewed, rating cleared: nothing left to keep.
  assert.equal(store.setRating('cunard:M626C', null, 'T3', sailing()), null);
  assert.deepEqual(store.all(), []);
});

test('clearing the rating of a viewed sailing keeps the view', async () => {
  const store = await openSelections(tmp());
  store.recordView(sailing(), 'T1');
  store.setRating('cunard:M626C', 5, 'T2', sailing());
  const row = store.setRating('cunard:M626C', null, 'T3', sailing());
  assert.equal(row.rating, null);
  assert.equal(row.views, 1);
});

test('a sailing no longer listed can be re-rated and keeps its old snapshot', async () => {
  const store = await openSelections(tmp());
  store.setRating('cunard:M626C', 3, 'T1', sailing({ price: 600 }));
  const row = store.setRating('cunard:M626C', 5, 'T2', null);
  assert.equal(row.rating, 5);
  assert.equal(row.snapshot.price, 600);
});

test('a rating that is not a whole number from 1 to 5 is refused', async () => {
  const store = await openSelections(tmp());
  for (const bad of [0, 6, 2.5, '4', undefined]) {
    assert.throws(() => store.setRating('cunard:M626C', bad, 'T', sailing()), RangeError, String(bad));
  }
  assert.deepEqual(store.all(), []);
});

test('rating an unknown sailing with nothing to snapshot is refused', async () => {
  const store = await openSelections(tmp());
  assert.throws(() => store.setRating('cunard:NOPE', 4, 'T', null), /No sailing/);
});

test('the map search uses holds rating and views by id', async () => {
  const store = await openSelections(tmp());
  store.recordView(sailing(), 'T1');
  store.setRating('viking:X', 2, 'T2', sailing({ id: 'viking:X' }));
  assert.deepEqual(selectionMap(store), {
    'cunard:M626C': { rating: null, views: 1 },
    'viking:X': { rating: 2, views: 0 },
  });
  assert.deepEqual(selectionMap({ ok: false, reason: 'x' }), {});
});

test('the data survives closing and reopening', async () => {
  const path = tmp();
  const a = await openSelections(path);
  a.setRating('cunard:M626C', 4, 'T1', sailing());
  a.close();
  const b = await openSelections(path);
  assert.equal(b.get('cunard:M626C').rating, 4);
});
