import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSelections, nodeSupportsSqlite, snapshotOf, selectionMap, handleSelections, exportPath } from '../selections.js';

// Scratch folders for this file's tests, removed when the file's tests finish — every run
// used to leave its folders in the system temp folder (2,542 had piled up by 2026-10-15).
const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const scratchDir = () => { const dir = mkdtempSync(join(tmpdir(), 'sel-')); scratch.push(dir); return dir; };
const tmp = () => join(scratchDir(), 'selections.db');
const sailing = (over = {}) => ({
  id: 'cunard:M626C', line: 'Cunard', ship: 'Queen Mary 2', itinerary: 'Southampton To Hamburg',
  destination: 'europe', departureDate: '2026-10-18', nights: 2, price: 504.74, currency: 'CAD',
  cabin: 'interior', url: 'https://www.cunard.com/x', image: null, departurePort: 'Southampton',
  ports: ['ignored'], cabinPrices: { interior: 504.74 }, tripType: 'cruise', ...over,
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
  const dir = scratchDir();
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
    'cabin', 'cabinPrices', 'currency', 'departureDate', 'departurePort', 'destination', 'id', 'image',
    'itinerary', 'line', 'nights', 'price', 'ship', 'tripType', 'url',
  ]);
});

test('a departed cruise keeps its trip type and cabin prices, for its label and the cabin filter', () => {
  const snap = snapshotOf(sailing({ tripType: 'cruisetour', cabinPrices: { interior: 900, balcony: 1400 } }));
  assert.equal(snap.tripType, 'cruisetour');
  assert.deepEqual(snap.cabinPrices, { interior: 900, balcony: 1400 });
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

const listed = [sailing(), sailing({ id: 'viking:X', line: 'Viking' })];
const call = (store, method, path, body) =>
  handleSelections({ method, path, body: body === undefined ? '' : JSON.stringify(body) },
    { store, sailings: listed, now: () => 'NOW' });

test('the handler ignores other paths', async () => {
  assert.equal(call(await openSelections(tmp()), 'GET', '/api/dataset'), null);
});

test('GET lists, POST view records, PUT rating sets and clears', async () => {
  const store = await openSelections(tmp());
  assert.deepEqual(call(store, 'GET', '/api/selections'), { status: 200, body: { selections: [] } });
  const viewed = call(store, 'POST', '/api/selections/view', { id: 'cunard:M626C' });
  assert.equal(viewed.status, 200);
  assert.equal(viewed.body.selection.views, 1);
  assert.equal(viewed.body.selection.lastViewed, 'NOW');
  const rated = call(store, 'PUT', '/api/selections/rating', { id: 'viking:X', rating: 5 });
  assert.equal(rated.body.selection.rating, 5);
  const cleared = call(store, 'PUT', '/api/selections/rating', { id: 'viking:X', rating: null });
  assert.deepEqual(cleared, { status: 200, body: { selection: null } });
  assert.equal(call(store, 'GET', '/api/selections').body.selections.length, 1);
});

test('bad input is a 400 with a message', async () => {
  const store = await openSelections(tmp());
  const cases = [
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: 0 }],
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: 6 }],
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: 2.5 }],
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: '4' }],
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C' }],
    ['PUT', '/api/selections/rating', { rating: 4 }],
    ['POST', '/api/selections/view', {}],
    ['POST', '/api/selections/view', [1, 2]],
  ];
  for (const [m, p, b] of cases) {
    const out = call(store, m, p, b);
    assert.equal(out.status, 400, JSON.stringify(b));
    assert.equal(typeof out.body.error, 'string');
  }
  const notJson = handleSelections({ method: 'POST', path: '/api/selections/view', body: '{nope' },
    { store, sailings: listed });
  assert.equal(notJson.status, 400);
  assert.deepEqual(store.all(), []);
});

test('an unknown sailing is a 404; a view of an unlisted one too', async () => {
  const store = await openSelections(tmp());
  assert.equal(call(store, 'POST', '/api/selections/view', { id: 'cunard:GONE' }).status, 404);
  assert.equal(call(store, 'PUT', '/api/selections/rating', { id: 'cunard:GONE', rating: 3 }).status, 404);
});

test('an unlisted sailing that has a row can still be re-rated', async () => {
  const store = await openSelections(tmp());
  store.setRating('cunard:GONE', 2, 'T1', sailing({ id: 'cunard:GONE' }));
  const out = call(store, 'PUT', '/api/selections/rating', { id: 'cunard:GONE', rating: 4 });
  assert.equal(out.status, 200);
  assert.equal(out.body.selection.rating, 4);
});

test('an unknown method or sub-path is a 404', async () => {
  const store = await openSelections(tmp());
  assert.equal(call(store, 'DELETE', '/api/selections').status, 404);
  assert.equal(call(store, 'GET', '/api/selections/rating').status, 404);
});

test('when the store is unavailable every route is a 503 saying why', () => {
  const store = { ok: false, reason: 'Ratings need Node 24.15 or later' };
  for (const [m, p] of [['GET', '/api/selections'], ['POST', '/api/selections/view'], ['PUT', '/api/selections/rating']]) {
    assert.deepEqual(call(store, m, p, { id: 'cunard:M626C', rating: 3 }),
      { status: 503, body: { error: 'Ratings need Node 24.15 or later' } });
  }
});

test('the export is written beside the database it came from', () => {
  assert.equal(exportPath('/scratch/sel-check.db', '2026-10-15'), '/scratch/selections-export-2026-10-15.json');
  assert.match(exportPath(undefined, '2026-10-15'), /\/ai-cruises\/data\/selections-export-2026-10-15\.json$/);
});

test('clearing views: an unrated cruise leaves, a rated one keeps its rating', async () => {
  const store = await openSelections(tmp());
  store.recordView(sailing(), 'T1');
  store.recordView(sailing(), 'T2');
  // Viewed only: nothing left to keep.
  assert.equal(store.clearViews('cunard:M626C'), null);
  assert.deepEqual(store.all(), []);

  store.recordView(sailing(), 'T3');
  store.setRating('cunard:M626C', 4, 'T4', sailing());
  const row = store.clearViews('cunard:M626C');
  assert.equal(row.rating, 4);
  assert.equal(row.views, 0);
  assert.equal(row.firstViewed, null);
  assert.equal(row.lastViewed, null);
});

test('forgetting removes a cruise entirely, rating and views', async () => {
  const store = await openSelections(tmp());
  store.recordView(sailing(), 'T1');
  store.setRating('cunard:M626C', 5, 'T2', sailing());
  store.forget('cunard:M626C');
  assert.deepEqual(store.all(), []);
});

test('POST unview and forget, by id; a cruise with no row is a 404', async () => {
  const store = await openSelections(tmp());
  call(store, 'POST', '/api/selections/view', { id: 'cunard:M626C' });
  call(store, 'PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: 3 });
  const unviewed = call(store, 'POST', '/api/selections/unview', { id: 'cunard:M626C' });
  assert.equal(unviewed.status, 200);
  assert.equal(unviewed.body.selection.views, 0);
  assert.equal(unviewed.body.selection.rating, 3);
  assert.deepEqual(call(store, 'POST', '/api/selections/forget', { id: 'cunard:M626C' }), { status: 200, body: { selection: null } });
  assert.deepEqual(store.all(), []);
  // Works for a cruise no longer listed too: it is the row that matters, not the listing.
  store.setRating('cunard:GONE', 2, 'T1', sailing({ id: 'cunard:GONE' }));
  assert.equal(call(store, 'POST', '/api/selections/forget', { id: 'cunard:GONE' }).status, 200);
  for (const p of ['/api/selections/unview', '/api/selections/forget']) {
    assert.equal(call(store, 'POST', p, { id: 'cunard:NEVER' }).status, 404, p);
    assert.equal(call(store, 'POST', p, {}).status, 400, p);
  }
});
