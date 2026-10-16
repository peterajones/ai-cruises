import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { openSelections, snapshotOf, nodeSupportsSqlite } from '../selections.js';
import { createLimiter } from '../auth.js';
import { handleSync, keyMatches, checkSailings, storeSailings, LIMITS } from '../sync-server.js';
import { syncConfig, uploadSailings, pullRatings, pushRatings } from '../sync.js';

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const scratchDir = () => { const dir = mkdtempSync(join(tmpdir(), 'sync-')); scratch.push(dir); return dir; };
const dbTest = nodeSupportsSqlite() ? test : (name, fn) => test(name, { skip: 'needs Node 24.15+' }, fn);

const KEY = 'k'.repeat(40);
const sailing = (i) => ({ id: `viking:${i}`, line: 'Viking', departureDate: '2027-01-02', ship: 'Viking Mars' });
const dataset = (n) => ({ scrapedAt: '2026-10-16T00:00:00Z', sailings: Array.from({ length: n }, (_, i) => sailing(i)), ships: {} });
const gz = (o) => gzipSync(Buffer.from(JSON.stringify(o)));

/** A request as server.js hands it to handleSync. */
const req = ({ method = 'PUT', path = '/api/sync/sailings', query = '', key = KEY, body = Buffer.alloc(0), gzip = true } = {}) => ({
  method, path, query: new URLSearchParams(query),
  headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(gzip ? { 'content-encoding': 'gzip' } : {}) },
  readBody: async () => body,
});
async function context({ current = null, store = null } = {}) {
  const dir = scratchDir();
  if (current) writeFileSync(join(dir, 'sailings.json'), JSON.stringify(current));
  return { key: KEY, dataDir: dir, store, address: '203.0.113.9', limiter: createLimiter() };
}

test('the key must match, compared whatever its length', () => {
  assert.ok(keyMatches(`Bearer ${KEY}`, KEY));
  assert.equal(keyMatches(`Bearer ${KEY}x`, KEY), false);
  assert.equal(keyMatches('Bearer ', KEY), false);
  assert.equal(keyMatches(KEY, KEY), false);
  assert.equal(keyMatches(undefined, KEY), false);
  assert.equal(keyMatches(`Bearer ${KEY}`, ''), false);
});

test('a wrong or missing key is refused, and counts toward the guessing limit', async () => {
  const ctx = await context();
  assert.equal((await handleSync(req({ key: 'wrong' }), ctx)).status, 401);
  assert.equal((await handleSync(req({ key: null }), ctx)).status, 401);
  for (let i = 0; i < 3; i += 1) await handleSync(req({ key: 'wrong' }), ctx);
  const out = await handleSync(req({ body: gz(dataset(5)) }), ctx);
  assert.equal(out.status, 429, 'blocked even with the right key after 5 wrong ones');
});

test('a server with no SYNC_KEY has no sync routes', async () => {
  const ctx = { ...(await context()), key: '' };
  assert.equal((await handleSync(req({ body: gz(dataset(5)) }), ctx)).status, 404);
});

test('an upload replaces the data, keeps the previous file, and says how many', async () => {
  const ctx = await context({ current: dataset(10) });
  const out = await handleSync(req({ body: gz(dataset(12)) }), ctx);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { stored: 12, was: 10 });
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.json'))).sailings.length, 12);
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.previous.json'))).sailings.length, 10);
});

test('the first upload, to an empty server, is accepted', async () => {
  const ctx = await context();
  assert.deepEqual((await handleSync(req({ body: gz(dataset(3)) }), ctx)).body, { stored: 3, was: 0 });
});

test('an upload with fewer than half the sailings is refused unless forced', async () => {
  const ctx = await context({ current: dataset(10) });
  const out = await handleSync(req({ body: gz(dataset(4)) }), ctx);
  assert.equal(out.status, 409);
  assert.match(out.body.error, /fewer than half/);
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.json'))).sailings.length, 10, 'unchanged');
  assert.equal((await handleSync(req({ body: gz(dataset(4)), query: 'force=1' }), ctx)).status, 200);
});

test('broken uploads are refused and change nothing', async () => {
  const ctx = await context({ current: dataset(10) });
  const cases = {
    'not gzip': req({ body: Buffer.from('{"sailings":[]}') }),
    'not JSON': req({ body: gzipSync(Buffer.from('{oops')) }),
    'no sailings': req({ body: gz({ sailings: [] }) }),
    'missing id': req({ body: gz({ sailings: [{ line: 'Viking', departureDate: '2027-01-02' }] }) }),
    'missing date': req({ body: gz({ sailings: Array.from({ length: 10 }, (_, i) => ({ ...sailing(i), departureDate: undefined })) }) }),
  };
  for (const [name, r] of Object.entries(cases)) {
    const out = await handleSync(r, ctx);
    assert.equal(out.status, 400, name);
    assert.ok(out.body.error, name);
  }
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.json'))).sailings.length, 10);
});

test('a zip bomb is stopped at the unpacked limit', async () => {
  const ctx = { ...(await context()), limits: { ...LIMITS, maxJson: 1024 * 1024 } };
  const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x20)); // ~4 KB packed, 4 MB unpacked
  const out = await handleSync(req({ body: bomb }), ctx);
  assert.equal(out.status, 413);
  assert.match(out.body.error, /unpacked/);
});

test('the current file is never absent: copied to .previous, then the new one renamed over it', async () => {
  const dir = scratchDir();
  writeFileSync(join(dir, 'sailings.json'), '{"sailings":[1]}');
  await storeSailings(dir, '{"sailings":[2]}');
  assert.equal(readFileSync(join(dir, 'sailings.json'), 'utf8'), '{"sailings":[2]}');
  assert.equal(readFileSync(join(dir, 'sailings.previous.json'), 'utf8'), '{"sailings":[1]}');
  assert.equal(existsSync(join(dir, 'sailings.json.tmp')), false);
});

test('checkSailings explains each refusal', () => {
  assert.equal(checkSailings(dataset(6), 10, false), null);
  assert.match(checkSailings(dataset(4), 10, false), /fewer than half the 10/);
  assert.equal(checkSailings(dataset(4), 10, true), null);
  assert.match(checkSailings({}, 0, false), /No sailings/);
});

dbTest('ratings come down with every column, and a push needs force when the server has rows', async () => {
  const store = await openSelections(join(scratchDir(), 'server.db'));
  store.recordView({ id: 'viking:1', line: 'Viking', departureDate: '2027-01-02' }, '2026-10-01T00:00:00Z');
  const ctx = await context({ store });
  const out = await handleSync(req({ method: 'GET', path: '/api/sync/selections', gzip: false }), ctx);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.selections, store.all());

  const rows = [{ sailingId: 'cunard:1', rating: 5, views: 0, firstViewed: null, lastViewed: null, ratedAt: '2026-10-16T00:00:00Z', snapshot: snapshotOf({ id: 'cunard:1' }) }];
  const refused = await handleSync(req({ path: '/api/sync/selections', body: gz({ selections: rows }) }), ctx);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already has 1/);
  const forced = await handleSync(req({ path: '/api/sync/selections', query: 'force=1', body: gz({ selections: rows }) }), ctx);
  assert.deepEqual(forced.body, { stored: 1 });
  assert.deepEqual(store.all(), rows);
  store.close();
});

dbTest('a 500-row push is accepted (bigger than the 64 KB other routes allow)', async () => {
  const store = await openSelections(join(scratchDir(), 'server.db'));
  const ctx = await context({ store });
  const rows = Array.from({ length: 500 }, (_, i) => ({
    sailingId: `royal:${i}`, rating: 3, views: 1, firstViewed: null, lastViewed: null, ratedAt: null,
    snapshot: snapshotOf({ id: `royal:${i}`, itinerary: 'x'.repeat(200), image: `https://example.com/${'p'.repeat(150)}.jpg` }),
  }));
  assert.ok(JSON.stringify({ selections: rows }).length > 64 * 1024);
  assert.deepEqual((await handleSync(req({ path: '/api/sync/selections', body: gz({ selections: rows }) }), ctx)).body, { stored: 500 });
  store.close();
});

// The client, against handleSync itself — no network.
const fetchVia = (ctx) => async (url, init = {}) => {
  const u = new URL(url);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const out = await handleSync({
    method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, headers,
    readBody: async () => Buffer.from(init.body ?? ''),
  }, ctx);
  return new Response(JSON.stringify(out.body), { status: out.status });
};
const config = { url: 'https://ai-cruises.example', key: KEY };

test('SYNC_URL must be https, except localhost', () => {
  assert.equal(syncConfig({}), null);
  assert.equal(syncConfig({ SYNC_URL: 'https://x.org' }), null, 'no key');
  assert.deepEqual(syncConfig({ SYNC_URL: 'https://x.org/', SYNC_KEY: KEY }), { url: 'https://x.org', key: KEY });
  assert.deepEqual(syncConfig({ SYNC_URL: 'http://localhost:3031', SYNC_KEY: KEY }), { url: 'http://localhost:3031', key: KEY });
  assert.throws(() => syncConfig({ SYNC_URL: 'http://x.org', SYNC_KEY: KEY }), /https/);
});

test('uploadSailings sends the file compressed and reports the server’s answer', async () => {
  const ctx = await context({ current: dataset(10) });
  const file = join(scratchDir(), 'sailings.json');
  writeFileSync(file, JSON.stringify(dataset(11)));
  assert.deepEqual(await uploadSailings({ config, dataFile: file, fetchImpl: fetchVia(ctx) }), { stored: 11, was: 10 });
});

test('the client explains a wrong key, a refusal and an unreachable server', async () => {
  const ctx = await context({ current: dataset(10) });
  const file = join(scratchDir(), 'sailings.json');
  writeFileSync(file, JSON.stringify(dataset(2)));
  await assert.rejects(uploadSailings({ config: { ...config, key: 'wrong' }, dataFile: file, fetchImpl: fetchVia(ctx) }), /SYNC_KEY/);
  await assert.rejects(uploadSailings({ config, dataFile: file, fetchImpl: fetchVia(ctx) }), /fewer than half/);
  const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(uploadSailings({ config, dataFile: file, fetchImpl: down }), /Could not reach https:\/\/ai-cruises\.example \(ECONNREFUSED\)/);
});

dbTest('pullRatings copies the server’s rows and the time; a cut-off answer changes nothing', async () => {
  const server = await openSelections(join(scratchDir(), 'server.db'));
  server.setRating('viking:1', 5, '2026-10-16T00:00:00Z', { id: 'viking:1', line: 'Viking' });
  const ctx = await context({ store: server });
  const mac = await openSelections(join(scratchDir(), 'mac.db'));
  mac.setRating('cunard:9', 2, '2026-10-01T00:00:00Z', { id: 'cunard:9' });

  assert.deepEqual(await pullRatings({ config, store: mac, fetchImpl: fetchVia(ctx), now: () => '2026-10-16T14:05:00Z' }), { copied: 1 });
  assert.deepEqual(mac.all(), server.all());
  assert.equal(mac.copiedAt(), '2026-10-16T14:05:00Z');

  const before = mac.all();
  const cutOff = async () => new Response('{"selections":[{"sailingId":"x"', { status: 200 });
  await assert.rejects(pullRatings({ config, store: mac, fetchImpl: cutOff }), /cut off/);
  assert.deepEqual(mac.all(), before);
  server.close(); mac.close();
});

dbTest('pushRatings moves the Mac’s rows to an empty server, once', async () => {
  const server = await openSelections(join(scratchDir(), 'server.db'));
  const ctx = await context({ store: server });
  const mac = await openSelections(join(scratchDir(), 'mac.db'));
  mac.setRating('cunard:9', 4, '2026-10-01T00:00:00Z', { id: 'cunard:9' });
  assert.deepEqual(await pushRatings({ config, store: mac, fetchImpl: fetchVia(ctx) }), { stored: 1 });
  assert.deepEqual(server.all(), mac.all());
  await assert.rejects(pushRatings({ config, store: mac, fetchImpl: fetchVia(ctx) }), /already has 1/);
  server.close(); mac.close();
});

test('checkSailings refuses a null or falsy sailing, naming its place', () => {
  for (const bad of [null, 0, '', false]) {
    const problem = checkSailings({ sailings: [sailing(1), bad] }, 0, false);
    assert.match(problem, /sailing 1, no id/, String(bad));
  }
  assert.match(checkSailings({ sailings: [{ id: 'x:1', line: 'V' }] }, 0, false), /\(x:1\)/);
});

test('an upload containing a null sailing is refused and the file is unchanged', async () => {
  const ctx = await context({ current: dataset(10) });
  const out = await handleSync(req({ body: gz({ sailings: [...dataset(10).sailings, null] }) }), ctx);
  assert.equal(out.status, 400);
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.json'))).sailings.length, 10);
});
