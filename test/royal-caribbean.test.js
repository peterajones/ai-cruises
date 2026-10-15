import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, parseShip, name, line, fetchListingPages, PAGE_SIZE, replayHeaders } from '../sites/royal-caribbean.js';
import { BotWallError } from '../errors.js';
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

test('every photo is the 1280px rendition, not the 2880px original', () => {
  // The originals are 0.7–2.8 MB; ?imwidth= and ?$800x450$ are ignored (checked 2026-10-15).
  const rows = parseListing(payload).filter((r) => r.image);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.match(row.image, /^https:\/\/www\.royalcaribbean\.com\/content\/dam\/.+\.jpg\/jcr:content\/renditions\/cq5dam\.web\.1280\.1280\.jpeg$/);
  }
});

test('the first row matches the hand-written golden row', () => {
  assert.deepEqual(parseListing(payload)[0], golden);
});

test('picks the cheapest tier, not the first non-null tier', () => {
  // Verified directly against the raw fixture: sailing WN4BH463_2028-01-10 has
  // stateroomClassPricing [INTERIOR 581.55, OUTSIDE 621.55, BALCONY 572.01,
  // DELUXE 1264.55] — INTERIOR is first-non-null but BALCONY is the true minimum.
  // A reduce-based minimum and a "take the first non-null tier" bug both pass
  // every other assertion in this file (the golden row's cheapest tier happens
  // to also be first), so this row is the one case in the fixture that tells
  // the two implementations apart.
  const row = parseListing(payload).find((r) => r.externalId === 'WN4BH463_2028-01-10');
  assert.ok(row, 'expected sailing WN4BH463_2028-01-10 to be present in the parsed output');
  assert.equal(row.cabin, 'BALCONY');
  assert.equal(row.price, 572.01);
});

test('skips a sailing whose stateroom tiers are all unpriced', () => {
  // Synthetic payload — not a real capture, hand-built to exercise the
  // all-null-price skip path (sites/royal-caribbean.js:29-30), which no row
  // in the real fixture happens to hit. Shaped like the real GraphQL response
  // but trimmed to only the fields parseListing reads.
  const syntheticPayload = JSON.stringify({
    data: {
      cruiseSearch: {
        results: {
          cruises: [
            {
              masterSailing: {
                itinerary: {
                  ship: { name: 'Synthetic Ship' },
                  departurePort: { name: 'Synthetic Port' },
                  destination: { name: 'Synthetic Sea' },
                  sailingNights: 5,
                },
              },
              sailings: [
                {
                  id: 'SYNTHETIC-ALL-NULL',
                  sailDate: '2030-01-01',
                  bookingLink: '/booking/landing?sailDate=2030-01-01',
                  stateroomClassPricing: [
                    { price: null, stateroomClass: { id: 'INTERIOR' } },
                    { price: null, stateroomClass: { id: 'OUTSIDE' } },
                  ],
                },
                {
                  id: 'SYNTHETIC-PRICED',
                  sailDate: '2030-01-08',
                  bookingLink: '/booking/landing?sailDate=2030-01-08',
                  stateroomClassPricing: [
                    { price: null, stateroomClass: { id: 'INTERIOR' } },
                    {
                      price: { value: 999.99, currency: { code: 'USD' } },
                      stateroomClass: { id: 'BALCONY' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  });

  const rows = parseListing(syntheticPayload);
  assert.equal(rows.length, 1, `expected exactly the priced sailing, got: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].externalId, 'SYNTHETIC-PRICED');
  assert.equal(rows[0].cabin, 'BALCONY');
  assert.equal(rows[0].price, 999.99);
});

test('returns an empty array instead of throwing when a sibling GraphQL operation lacks cruiseSearch', () => {
  // Synthetic payload — one of the four batched GraphQL responses that hit
  // cruises/graph on a real page load carries a completely different shape
  // (e.g. a filter/facet query). parseListing must not crash a run when it
  // is handed one of those by mistake; it should just yield no rows.
  const siblingOperationPayload = JSON.stringify({
    data: {
      someOtherOperation: {
        results: { facets: [] },
      },
    },
  });

  assert.deepEqual(parseListing(siblingOperationPayload), []);
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

test('the cabin table normalizes to cabin types, without unpriced classes', () => {
  const { sailings } = normalizeAll(parseListing(payload), { source: 'royal-caribbean', line: 'Royal Caribbean' });
  assert.deepEqual(sailings[0].cabinPrices, { interior: 598.16, balcony: 1028.16 });
  assert.ok(sailings.every((s) => s.cabinPrices && s.cabinPrices[s.cabin] === s.price));
});

// A replayed page is the captured answer's shape with some of its cruises (real data, sliced).
const cruises = JSON.parse(payload).data.cruiseSearch.results.cruises;
const answer = (list, total) => JSON.stringify({
  data: { cruiseSearch: { results: { cruises: list, total }, __typename: 'CruiseSearch' } },
});
const PAGE_BODY = {
  query: 'query CruisesSearchResults($filters: String, $pagination: CruiseSearchPagination) { cruiseSearch { results { total } } }',
  variables: { filters: '', sort: { by: 'RECOMMENDED' }, pagination: { count: 10, skip: 0 }, enableNewCasinoExperience: true },
};
const FACETS_BODY = { query: 'query csearchWidget_FacetOptions ($filters: String) { cruiseSearch { filters { key } } }', variables: {} };
const PAGE_HEADERS = {
  ':authority': 'www.royalcaribbean.com', brand: 'R', country: 'USA', currency: 'USD', office: 'MIA',
  'content-type': 'application/json', 'x-session-id': 'abc', cookie: 'x=1', 'user-agent': 'UA',
  'sec-fetch-mode': 'cors', origin: 'https://www.royalcaribbean.com', 'content-length': '6615',
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
            url: () => 'https://www.royalcaribbean.com/cruises/graph',
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
  assert.equal(body.variables.filters, '');
  assert.deepEqual(body.variables.sort, { by: 'RECOMMENDED' });
  assert.equal(body.variables.enableNewCasinoExperience, true);
  assert.deepEqual(headers, {
    brand: 'R', country: 'USA', currency: 'USD', office: 'MIA', 'content-type': 'application/json', 'x-session-id': 'abc',
  });
  assert.deepEqual(replayHeaders({ cookie: 'x', ':path': '/', referer: 'r', brand: 'R' }), { brand: 'R' });
});

test('captures the first search request only, ignoring other operations', async () => {
  const second = { ...PAGE_BODY, variables: { ...PAGE_BODY.variables, filters: 'destination:ALCAN' } };
  const page = fakePage(halves, { sent: [FACETS_BODY, PAGE_BODY, second] });
  await run(page);
  assert.equal(page.calls[0].body.variables.filters, '');
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
  const page = fakePage(({ count, skip }) => answer(cruises.slice(skip, skip + count), 930));
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
  // Live, 2026-10-15: the site's order shifts between requests, so paging by skip returned
  // 67 cruises twice and 67 never.
  const page = fakePage(() => answer(cruises.slice(0, 5), 4000));
  await assert.rejects(run(page), /overlapped/);
});
