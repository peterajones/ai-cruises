import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags, describeMisses, linesToKeep, withinNextYear } from '../scrape.js';
import { ADAPTERS, adaptersFor } from '../sites/index.js';

test('the registered adapter is royal-caribbean', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.name), ['royal-caribbean', 'celebrity', 'princess', 'holland-america', 'viking', 'cunard']);
});

test('every adapter satisfies the contract', () => {
  for (const adapter of ADAPTERS) {
    for (const fn of ['parseListing', 'parseShip', 'fetchListingPages', 'fetchShipPage', 'shipUrl']) {
      assert.equal(typeof adapter[fn], 'function', `${adapter.name} is missing ${fn}`);
    }
    assert.equal(typeof adapter.line, 'string');
  }
});

test('adaptersFor selects by name and defaults to all', () => {
  assert.deepEqual(adaptersFor([]).map((a) => a.name), ['royal-caribbean', 'celebrity', 'princess', 'holland-america', 'viking', 'cunard']);
  assert.deepEqual(adaptersFor(['royal-caribbean']).map((a) => a.name), ['royal-caribbean']);
});

test('adaptersFor rejects an unknown site rather than silently scraping nothing', () => {
  assert.throws(() => adaptersFor(['carnival']), /carnival/);
});

test('flags have sensible defaults', () => {
  // Infinity, not a number: any fixed default silently caps the real dataset.
  assert.deepEqual(parseFlags([]), {
    limit: Infinity, sites: [], refreshShips: false, dryRun: false,
  });
});

test('flags parse', () => {
  const flags = parseFlags(['--limit', '50', '--site', 'royal-caribbean', '--refresh-ships', '--dry-run']);
  assert.equal(flags.limit, 50);
  assert.deepEqual(flags.sites, ['royal-caribbean']);
  assert.equal(flags.refreshShips, true);
  assert.equal(flags.dryRun, true);
});

test('--site can be repeated', () => {
  assert.deepEqual(parseFlags(['--site', 'royal-caribbean', '--site', 'carnival']).sites,
    ['royal-caribbean', 'carnival']);
});

test('skipped sailings are not reported as missing aliases', () => {
  const lines = describeMisses([
    { field: 'row', raw: 'princess:3704_2027-01-17 missing price', count: 1 },
    { field: 'row', raw: 'princess:X801_2027-12-29 missing price', count: 1 },
  ]);
  assert.deepEqual(lines, [
    '2 sailings skipped — a required field is missing (Princess drops a few unpriced ones every run):',
    '  princess:3704_2027-01-17 missing price',
    '  princess:X801_2027-12-29 missing price',
  ]);
});

test('unknown labels point at normalize.js and unknown ports at airports.js', () => {
  const lines = describeMisses([
    { field: 'destination', raw: 'Sea of Cortez', count: 3 },
    { field: 'airport', raw: 'Tromsø', count: 2 },
  ]);
  assert.deepEqual(lines, [
    '1 unrecognised value — add an alias to normalize.js:',
    '  destination: "Sea of Cortez" (3x)',
    '1 port with no airport — add it to airports.js:',
    '  airport: "Tromsø" (2x)',
  ]);
});

test('nothing missed prints nothing', () => {
  assert.deepEqual(describeMisses([]), []);
});

const ALL = ['royal-caribbean', 'celebrity', 'princess', 'holland-america', 'viking', 'cunard'];

test('a full run that worked keeps nothing from the previous run', () => {
  assert.deepEqual(linesToKeep(ALL, ALL, new Set()), []);
});

test('a line that failed keeps its previous sailings', () => {
  assert.deepEqual(linesToKeep(ALL, ALL, new Set(['viking'])), [{ name: 'viking', reason: 'failed' }]);
});

test('--site keeps every line it did not scrape, so one line cannot wipe the others', () => {
  assert.deepEqual(linesToKeep(ALL, ['royal-caribbean'], new Set()), [
    { name: 'celebrity', reason: 'not scraped' },
    { name: 'princess', reason: 'not scraped' },
    { name: 'holland-america', reason: 'not scraped' },
    { name: 'viking', reason: 'not scraped' },
    { name: 'cunard', reason: 'not scraped' },
  ]);
  assert.deepEqual(linesToKeep(ALL, ['viking', 'cunard'], new Set(['cunard'])), [
    { name: 'royal-caribbean', reason: 'not scraped' },
    { name: 'celebrity', reason: 'not scraped' },
    { name: 'princess', reason: 'not scraped' },
    { name: 'holland-america', reason: 'not scraped' },
    { name: 'cunard', reason: 'failed' },
  ]);
});

const sail = (source, departureDate) => ({ id: `${source}:${departureDate}`, source, departureDate });

test('the next 12 months: tomorrow through today + 365, nothing else', () => {
  const { kept, beyond } = withinNextYear([
    sail('princess', '2026-10-15'), // today: sailing or sailed
    sail('princess', '2026-10-16'), // tomorrow
    sail('princess', '2027-10-15'), // + 365
    sail('princess', '2027-10-16'), // + 366
    sail('celebrity', '2025-01-01'),
  ], '2026-10-15');
  assert.deepEqual(kept.map((s) => s.departureDate), ['2026-10-16', '2027-10-15']);
  assert.deepEqual(beyond, { princess: 2, celebrity: 1 });
});

test('the window crosses a leap day and a year end correctly', () => {
  const { kept } = withinNextYear([sail('viking', '2028-02-29'), sail('viking', '2028-03-01')], '2027-03-01');
  // 2027-03-01 + 365 days = 2028-02-29 (2028 is a leap year).
  assert.deepEqual(kept.map((s) => s.departureDate), ['2028-02-29']);
});

test('carried-over sailings are trimmed too — nothing is exempt', () => {
  const { kept, beyond } = withinNextYear([sail('holland-america', '2028-07-16')], '2026-10-15');
  assert.deepEqual(kept, []);
  assert.deepEqual(beyond, { 'holland-america': 1 });
});
