import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNonEmpty, dedupeById, loadExisting, mergeShips, writeResult } from '../persist.js';
import { ConflictingDuplicateError, EmptyResultError } from '../errors.js';

const sampleResult = () => ({
  scrapedAt: '2026-08-03T22:40:00.000Z',
  sailings: [{ id: 'princess:1', ship: 'Sky Princess', nights: 7 }],
  ships: { 'Sky Princess': { line: 'Princess', description: 'A ship.', url: 'https://x' } },
  values: { line: ['Princess'], destination: [], cabin: [], departurePort: [], nights: [7] },
  unrecognised: [],
});

test('zero rows throws rather than being treated as no results', () => {
  assert.throws(() => assertNonEmpty([], 'princess listing page 1'), EmptyResultError);
  assert.doesNotThrow(() => assertNonEmpty([{}], 'princess listing page 1'));
});

test('writeResult writes sailings.json and a dated run snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cruise-'));
  await writeResult(dir, sampleResult());

  const written = JSON.parse(await readFile(join(dir, 'sailings.json'), 'utf8'));
  assert.equal(written.sailings.length, 1);

  const runs = await readdir(join(dir, 'runs'));
  assert.equal(runs.length, 1);
  assert.match(runs[0], /^\d{4}-\d{2}-\d{2}T.*\.json$/);
});

test('writeResult leaves no temp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cruise-'));
  await writeResult(dir, sampleResult());
  const files = await readdir(dir);
  assert.ok(!files.some((f) => f.endsWith('.tmp')), `temp file left: ${files.join(', ')}`);
});

test('writeResult leaves no temp file behind in runs/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cruise-'));
  await writeResult(dir, sampleResult());
  const runs = await readdir(join(dir, 'runs'));
  assert.ok(!runs.some((f) => f.endsWith('.tmp')), `temp file left in runs/: ${runs.join(', ')}`);
});

test('loadExisting returns null when there is nothing yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cruise-'));
  assert.equal(await loadExisting(dir), null);
});

test('loadExisting round-trips what writeResult wrote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cruise-'));
  await writeResult(dir, sampleResult());
  const loaded = await loadExisting(dir);
  assert.equal(loaded.sailings[0].id, 'princess:1');
});

test('mergeShips keeps cached descriptions and adds new ships', () => {
  const existing = { 'Sky Princess': { line: 'Princess', description: 'cached', url: 'https://a' } };
  const fresh = { 'Icon of the Seas': { line: 'Royal Caribbean', description: 'new', url: 'https://b' } };
  const merged = mergeShips(existing, fresh, { refresh: false });
  assert.equal(merged['Sky Princess'].description, 'cached');
  assert.equal(merged['Icon of the Seas'].description, 'new');
});

test('mergeShips with refresh prefers the fresh description', () => {
  const existing = { 'Sky Princess': { line: 'Princess', description: 'stale', url: 'https://a' } };
  const fresh = { 'Sky Princess': { line: 'Princess', description: 'fresh', url: 'https://a' } };
  assert.equal(mergeShips(existing, fresh, { refresh: true })['Sky Princess'].description, 'fresh');
  assert.equal(mergeShips(existing, fresh, { refresh: false })['Sky Princess'].description, 'stale');
});

// A single page load fires several GraphQL operations at one endpoint, and more
// than one can carry the same sailings — the run that reported "442 sailings"
// was really 321, with Celebrity's 118 counted twice.
test('dedupeById drops repeats and keeps the first occurrence', () => {
  const rows = [
    { id: 'celebrity:A', price: 100 },
    { id: 'celebrity:B', price: 200 },
    { id: 'celebrity:A', price: 100 },
  ];
  const { sailings, duplicates } = dedupeById(rows);
  assert.equal(duplicates, 1);
  assert.deepEqual(sailings.map((s) => s.id), ['celebrity:A', 'celebrity:B']);
  assert.equal(sailings[0].price, 100, 'kept the first occurrence');
});

test('dedupeById reports zero on already-unique input', () => {
  const rows = [{ id: 'a:1' }, { id: 'a:2' }, { id: 'a:3' }];
  const { sailings, duplicates } = dedupeById(rows);
  assert.equal(duplicates, 0);
  assert.equal(sailings.length, 3);
});

test('dedupeById does not collapse the same external id across sources', () => {
  // normalizeAll prefixes ids with the source, so this must survive.
  const { sailings, duplicates } = dedupeById([
    { id: 'royal-caribbean:X' },
    { id: 'celebrity:X' },
  ]);
  assert.equal(duplicates, 0);
  assert.equal(sailings.length, 2);
});

// Dropping a row is only safe while rows sharing an id ARE the same sailing.
// That holds for today's captures, but it is an assumption about someone else's
// data — so a violation must fail loudly rather than discard a real cruise.
const sameSailing = () => ({
  id: 'celebrity:BY07W680_2026-08-23',
  ship: 'Celebrity Beyond',
  departureDate: '2026-08-23',
  nights: 7,
  departurePort: 'Miami',
  destination: 'caribbean',
  cabin: 'interior',
  price: 949.94,
  currency: 'USD',
});

test('dedupeById throws when two rows share an id but differ', () => {
  for (const [field, value] of [
    ['price', 1299],
    ['ship', 'Celebrity Edge'],
    ['departureDate', '2026-09-06'],
    ['nights', 9],
    ['cabin', 'balcony'],
    ['departurePort', 'Barcelona'],
    ['currency', 'EUR'],
  ]) {
    assert.throws(
      () => dedupeById([sameSailing(), { ...sameSailing(), [field]: value }]),
      ConflictingDuplicateError,
      `a differing ${field} should have thrown`,
    );
  }
});

test('the conflict error names the id and the fields that disagree', () => {
  try {
    dedupeById([sameSailing(), { ...sameSailing(), price: 1299, cabin: 'suite' }]);
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(err instanceof ConflictingDuplicateError);
    assert.deepEqual(err.fields, ['cabin', 'price']);
    assert.match(err.message, /BY07W680_2026-08-23/);
    assert.match(err.message, /949\.94 vs 1299/);
  }
});

test('presentation-only differences are not a conflict', () => {
  // A different hero image or port list is not a different cruise.
  const { sailings, duplicates } = dedupeById([
    { ...sameSailing(), image: 'https://a/x.jpg', itinerary: 'A', ports: ['X'], url: 'https://a' },
    { ...sameSailing(), image: 'https://b/y.jpg', itinerary: 'B', ports: ['Y'], url: 'https://b' },
  ]);
  assert.equal(duplicates, 1);
  assert.equal(sailings.length, 1);
});
