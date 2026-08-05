import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../scrape.js';
import { ADAPTERS, adaptersFor } from '../sites/index.js';

test('the registered adapter is royal-caribbean', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.name), ['royal-caribbean', 'celebrity']);
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
  assert.deepEqual(adaptersFor([]).map((a) => a.name), ['royal-caribbean', 'celebrity']);
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
