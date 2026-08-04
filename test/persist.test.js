import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNonEmpty, loadExisting, mergeShips, writeResult } from '../persist.js';
import { EmptyResultError } from '../errors.js';

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
