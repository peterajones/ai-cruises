import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags, describeMisses } from '../scrape.js';
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
