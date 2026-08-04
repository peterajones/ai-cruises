import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, parseShip, name, line } from '../sites/royal-caribbean.js';
import { normalizeAll } from '../normalize.js';

const payload = await readFile(new URL('./fixtures/royal-caribbean-listing.json', import.meta.url), 'utf8');
const shipHtml = await readFile(new URL('./fixtures/royal-caribbean-ship.html', import.meta.url), 'utf8');
const golden = JSON.parse(
  await readFile(new URL('./fixtures/royal-caribbean-first-row.json', import.meta.url), 'utf8'),
);

test('the adapter identifies itself', () => {
  assert.equal(name, 'royal-caribbean');
  assert.equal(line, 'Royal Caribbean');
});

test('parses exactly 204 sailings from the real fixture', () => {
  assert.equal(parseListing(payload).length, 204);
});

const REQUIRED_FIELDS = [
  'externalId',
  'ship',
  'departurePort',
  'destination',
  'departureDate',
  'nights',
  'cabin',
  'price',
  'currency',
];

test('every row has all required fields non-empty', () => {
  const rows = parseListing(payload);
  for (const row of rows) {
    for (const field of REQUIRED_FIELDS) {
      const value = row[field];
      const populated = value !== undefined && value !== null && value !== '';
      assert.ok(populated, `row ${JSON.stringify(row)} is missing field "${field}"`);
    }
  }
});

test('external IDs are unique across all 204 rows', () => {
  const ids = parseListing(payload).map((r) => r.externalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate externalId values found');
});

test('every departureDate is an ISO date', () => {
  const rows = parseListing(payload);
  for (const row of rows) {
    assert.match(row.departureDate, /^\d{4}-\d{2}-\d{2}$/, `bad departureDate in row: ${JSON.stringify(row)}`);
  }
});

test('every url is absolute against royalcaribbean.com', () => {
  const rows = parseListing(payload);
  for (const row of rows) {
    assert.ok(
      row.url.startsWith('https://www.royalcaribbean.com'),
      `bad url in row: ${JSON.stringify(row)}`,
    );
  }
});

test('the first row matches the hand-written golden row', () => {
  assert.deepEqual(parseListing(payload)[0], golden);
});

test('the fixture survives normalizeAll with no dropped rows', () => {
  const rows = parseListing(payload);
  const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
  assert.equal(
    sailings.length,
    204,
    `dropped rows: ${JSON.stringify(unrecognised.filter((u) => u.field === 'row'), null, 2)}`,
  );
});

test('parses a description out of the ship page', () => {
  const ship = parseShip(shipHtml);
  assert.equal(ship.line, 'Royal Caribbean');
  assert.ok(ship.description.length > 80, `description too short: "${ship.description}"`);
});
