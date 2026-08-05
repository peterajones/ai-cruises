import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, parseShip, shipUrl, name, line } from '../sites/celebrity.js';
import { normalizeAll } from '../normalize.js';

const payload = await readFile(new URL('./fixtures/celebrity-listing.json', import.meta.url), 'utf8');
const shipHtml = await readFile(new URL('./fixtures/celebrity-ship.html', import.meta.url), 'utf8');
const golden = JSON.parse(
  await readFile(new URL('./fixtures/celebrity-first-row.json', import.meta.url), 'utf8'),
);

const ORIGIN = 'https://www.celebritycruises.com';

test('the adapter identifies itself', () => {
  assert.equal(name, 'celebrity');
  assert.equal(line, 'Celebrity Cruises');
});

test('parses a non-empty list of sailings from the real fixture', () => {
  assert.equal(parseListing(payload).length, 119);
});

test('the first row matches the golden row', () => {
  assert.deepEqual(parseListing(payload)[0], golden);
});

test('every row has the fields normalizeAll requires', () => {
  for (const row of parseListing(payload)) {
    for (const field of ['externalId', 'ship', 'departureDate', 'nights', 'price']) {
      assert.ok(row[field], `missing ${field}: ${JSON.stringify(row)}`);
    }
  }
});

test('external IDs are unique', () => {
  const ids = parseListing(payload).map((r) => r.externalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate externalId values');
});

test('every departureDate is ISO', () => {
  for (const row of parseListing(payload)) {
    assert.match(row.departureDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

// The one thing a naive copy of the Royal Caribbean adapter gets wrong: image
// paths and booking links are site-relative, so a stale SITE_ORIGIN silently
// produces Celebrity content hosted at royalcaribbean.com. Every URL this
// adapter emits must point at Celebrity.
test('every URL points at celebritycruises.com, not royalcaribbean.com', () => {
  for (const row of parseListing(payload)) {
    assert.ok(row.url.startsWith(ORIGIN), `booking URL has wrong origin: ${row.url}`);
    if (row.image) {
      assert.ok(row.image.startsWith(ORIGIN), `image URL has wrong origin: ${row.image}`);
    }
  }
  assert.equal(shipUrl('Celebrity Beyond'), `${ORIGIN}/cruise-ships/celebrity-beyond`);
});

// The origin assertion above passed while every image 404'd: Celebrity's payload
// returns "/celebrity/new-images/..." but the asset lives at
// "/content/dam/celebrity/new-images/...". A right-origin, wrong-path URL is
// still a broken image, so assert the full shape rather than just the host.
test('image URLs carry the /content/dam asset root', () => {
  const images = parseListing(payload).map((r) => r.image).filter(Boolean);
  assert.ok(images.length > 0, 'expected at least one image');
  for (const image of images) {
    assert.ok(
      image.startsWith(`${ORIGIN}/content/dam/`),
      `image URL would 404 — missing asset root: ${image}`,
    );
    assert.ok(!image.includes('/content/dam/content/dam/'), `asset root applied twice: ${image}`);
  }
});

test('picks the cheapest priced tier, not the first', () => {
  // Verified against the raw fixture: cruise 0 / sailing 0 offers
  // INTERIOR 949.94, OUTSIDE 999.94, BALCONY 999.94, CONCIERGE 1199.94.
  const row = parseListing(payload).find((r) => r.externalId === 'BY07W680_2026-08-23');
  assert.ok(row, 'expected sailing BY07W680_2026-08-23 in the parsed output');
  assert.equal(row.cabin, 'INTERIOR');
  assert.equal(row.price, 949.94);
});

test('the fixture survives normalizeAll with no drops and nothing unrecognised', () => {
  const rows = parseListing(payload);
  const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
  assert.equal(
    sailings.length,
    rows.length,
    `dropped rows: ${JSON.stringify(unrecognised.filter((u) => u.field === 'row'), null, 2)}`,
  );
  assert.deepEqual(unrecognised, [], 'every Celebrity label should map');
});

// Celebrity's ship pages have no introCopy block, so this exercises the
// og:description fallback — the branch that returns '' on a Royal Caribbean-only
// implementation.
test('falls back to the meta description when there is no introCopy block', () => {
  assert.equal(/introCopy/.test(shipHtml), false, 'fixture unexpectedly has introCopy');
  const ship = parseShip(shipHtml);
  assert.equal(ship.line, 'Celebrity Cruises');
  assert.equal(ship.source, 'meta');
  assert.ok(ship.description.length > 80, `description too short: "${ship.description}"`);
});

test('an unrecognised payload shape yields no rows rather than throwing', () => {
  // Synthetic — a sibling GraphQL operation must not crash a run.
  assert.deepEqual(parseListing('{"data":{"other":{}}}'), []);
});
