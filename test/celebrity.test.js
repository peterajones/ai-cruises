import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, parseShip, shipUrl, name, line, fetchListingPages, PAGE_SIZE, replayHeaders } from '../sites/celebrity.js';
import { BotWallError } from '../errors.js';
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

test('the cabin table folds Concierge into balcony, keeping the cheaper price', () => {
  const { sailings } = normalizeAll(parseListing(payload), { source: 'celebrity', line: 'Celebrity Cruises' });
  assert.deepEqual(sailings[0].cabinPrices, { interior: 949.94, oceanview: 999.94, balcony: 999.94 });
  assert.ok(sailings.every((s) => s.cabinPrices && s.cabinPrices[s.cabin] === s.price));
});

// A replayed page is the captured answer's shape with some of its cruises (real data, sliced).
const cruises = JSON.parse(payload).data.cruiseSearch.results.cruises;
const answer = (list, total) => JSON.stringify({
  data: { cruiseSearch: { results: { cruises: list, total }, __typename: 'CruiseSearch' } },
});
const PAGE_BODY = {
  query: 'query CruisesSearchResults($filters: String, $pagination: CruiseSearchPagination) { cruiseSearch { results { total } } }',
  variables: { filters: 'voyageType:OCEAN', sort: { by: 'RECOMMENDED' }, pagination: { count: 10, skip: 0 }, enableNewCasinoExperience: true },
};
const FACETS_BODY = { query: 'query csearchWidget_FacetOptions ($filters: String) { cruiseSearch { filters { key } } }', variables: {} };
const PAGE_HEADERS = {
  ':authority': 'www.celebritycruises.com', brand: 'C', country: 'USA', currency: 'USD', office: 'MIA',
  'content-type': 'application/json', 'x-session-id': 'abc', cookie: 'x=1', 'user-agent': 'UA',
  'sec-fetch-mode': 'cors', origin: 'https://www.celebritycruises.com', 'content-length': '6615',
};

/** `route(pagination, body)` answers each replay: a string is a 200 body; an object is { status, text }. */
function fakePage(route, { sent = [FACETS_BODY, PAGE_BODY], html = `<html><body>${'Cruises. '.repeat(200)}</body></html>` } = {}) {
  const listeners = [];
  const p = {
    calls: [],
    on: (event, fn) => { if (event === 'request') listeners.push(fn); },
    off: (event, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    goto: async () => {
      for (const body of sent) {
        for (const fn of [...listeners]) {
          fn({
            method: () => 'POST',
            url: () => 'https://www.celebritycruises.com/cruises/graph',
            postData: () => JSON.stringify(body),
            headers: () => PAGE_HEADERS,
          });
        }
      }
      return { status: () => 200 };
    },
    content: async () => html,
    evaluate: async (_fn, path, headers, body) => {
      const parsed = JSON.parse(body);
      p.calls.push({ path, headers, body: parsed });
      const a = route(parsed.variables.pagination, parsed);
      return typeof a === 'string' ? { status: 200, text: a } : a;
    },
  };
  return p;
}
const noPause = async () => {};
const run = (page, opts = {}) => fetchListingPages(page, { limit: Infinity, pause: noPause, ...opts });
// A catalogue bigger than one request: the two halves of the fixture's cruises.
const halves = ({ skip }) => answer(skip === 0 ? cruises.slice(0, 5) : cruises.slice(5), 4000);

test('the fetch replays the page’s own search, 3000 cruises at a time, until total', async () => {
  const page = fakePage(halves);
  const payloads = await run(page);
  assert.equal(PAGE_SIZE, 3000);
  assert.deepEqual(page.calls.map((c) => c.body.variables.pagination), [{ count: 3000, skip: 0 }, { count: 3000, skip: 3000 }]);
  assert.equal(page.calls[0].path, '/cruises/graph');
  assert.equal(payloads.flatMap((p) => parseListing(p)).length, parseListing(payload).length);
});

test('the replay keeps the page’s query, filters and sort, and drops browser-set headers', async () => {
  const page = fakePage(halves);
  await run(page);
  const { body, headers } = page.calls[0];
  assert.equal(body.query, PAGE_BODY.query);
  assert.equal(body.variables.filters, 'voyageType:OCEAN');
  assert.deepEqual(body.variables.sort, { by: 'RECOMMENDED' });
  assert.equal(body.variables.enableNewCasinoExperience, true);
  assert.deepEqual(headers, {
    brand: 'C', country: 'USA', currency: 'USD', office: 'MIA', 'content-type': 'application/json', 'x-session-id': 'abc',
  });
  assert.deepEqual(replayHeaders({ cookie: 'x', ':path': '/', referer: 'r', brand: 'R' }), { brand: 'R' });
});

test('captures the first search request only, ignoring other operations', async () => {
  const second = { ...PAGE_BODY, variables: { ...PAGE_BODY.variables, filters: 'voyageType:RIVER' } };
  const page = fakePage(halves, { sent: [FACETS_BODY, PAGE_BODY, second] });
  await run(page);
  assert.equal(page.calls[0].body.variables.filters, 'voyageType:OCEAN');
});

test('an empty page ends the fetch when no total is given', async () => {
  const page = fakePage(({ skip }) => answer(skip === 0 ? cruises : [], undefined));
  const payloads = await run(page);
  assert.equal(page.calls.length, 2);
  assert.equal(payloads.length, 1);
});

test('20 pages without an end fails loudly instead of truncating', async () => {
  // A different cruise every page, so only the page count can stop it.
  const page = fakePage(({ skip }) => answer([{ ...cruises[0], id: `X${skip}` }], undefined));
  await assert.rejects(run(page), /more than 20 pages/);
  assert.equal(page.calls.length, 20);
});

test('limit asks for that many cruises, and stops once it has enough sailings', async () => {
  const page = fakePage(({ count, skip }) => answer(cruises.slice(skip, skip + count), 479));
  await run(page, { limit: 5 });
  assert.deepEqual(page.calls.map((c) => c.body.variables.pagination), [{ count: 5, skip: 0 }]);
});

test('the fetch reports each page', async () => {
  const seen = [];
  await run(fakePage(halves), { onProgress: (t) => seen.push(t) });
  assert.deepEqual(seen, ['page 1/2', 'page 2/2']);
});

test('no search request from the page fails loudly', async () => {
  await assert.rejects(run(fakePage(halves, { sent: [FACETS_BODY] })), /sent no CruisesSearchResults request/);
});

test('a bad answer fails loudly', async () => {
  await assert.rejects(run(fakePage(() => ({ status: 500, text: '{"error":"x"}' }))), /HTTP 500/);
  await assert.rejects(run(fakePage(() => ({ status: 502, text: '' }))), /no JSON/);
  await assert.rejects(run(fakePage(() => '{"errors":[{"message":"bad"}]}')), /GraphQL errors/);
  await assert.rejects(run(fakePage(() => '{"data":{"cruiseSearch":{}}}')), /no results\.cruises/);
});

test('a block is a bot wall', async () => {
  await assert.rejects(run(fakePage(() => ({ status: 403, text: '{}' }))), BotWallError);
  await assert.rejects(run(fakePage(() => '<html><title>Access Denied</title></html>')), BotWallError);
  await assert.rejects(run(fakePage(halves, { html: '<html><title>Access Denied</title></html>' })), BotWallError);
});

test('a whole catalogue normally comes back in one request', async () => {
  const page = fakePage(() => answer(cruises, 10));
  await run(page);
  assert.deepEqual(page.calls.map((c) => c.body.variables.pagination), [{ count: 3000, skip: 0 }]);
});

test('pages that overlap fail loudly — a repeated cruise means another was missed', async () => {
  // Live on Royal Caribbean, the same platform, 2026-10-15: the order shifts between
  // requests, so paging by skip returned 67 cruises twice and 67 never.
  const page = fakePage(() => answer(cruises.slice(0, 5), 4000));
  await assert.rejects(run(page), /overlapped/);
});
