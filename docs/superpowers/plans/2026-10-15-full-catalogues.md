# Full Catalogues and a Rolling 12 Months Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Royal Caribbean and Celebrity read their whole catalogues instead of the page's first 10 cruises, and every line keeps only sailings departing in the next 12 months.

**Architecture:** Each of the two adapters loads `/cruises` as now, captures the `CruisesSearchResults` request the page itself sends, and replays it from inside the page with `pagination: { count: 500, skip }` until the catalogue is read. `parseListing` is unchanged. The 12-month horizon is one rule in `scrape.js`, applied to every line's sailings after normalizing and to carried-over lines. New destinations and airports go in `normalize.js` and `airports.js`.

**Tech Stack:** Node 24 (ESM), Puppeteer, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-full-catalogues-design.md` — read it first.

### Two planned departures from the spec

1. **The window lives in `scrape.js`, once, not copied into four adapters' `parseListing`.**
   The spec put a copy of `inWindow` in each adapter. But the real fixtures span more than a
   year (Royal Caribbean 2026-08 → 2028-04, Princess 2026-10 → 2028-10), so a window inside
   `parseListing` changes every existing count and golden test, and needs a pinned `today`
   threaded through all of them. The horizon is policy, not site knowledge: one rule in the
   pipeline applies it to all six lines, *and* to sailings carried over from a previous run
   (which a per-adapter filter would miss). Adapters stay site-only. Cunard and Viking keep
   their own fetch-time windows — those save requests, and the second filter is harmless.
2. **The fetch tests use the existing captured answers** (`royal-caribbean-listing.json`,
   `celebrity-listing.json`) rather than newly captured 500-cruise fixtures. They are real
   captures of this exact query's answer (same operation, same shape, with `total`); a
   replayed page differs only in how many cruises it holds, which the fake page controls by
   slicing them.

## Global Constraints

- Node 24, ESM. Dependencies stay `puppeteer` and `@anthropic-ai/sdk`.
- Adapters are standalone files; never import one from another. Royal Caribbean and Celebrity stay near-duplicates.
- Horizon for every line: departing after today and on or before today + 365 days (local date).
- No copy of the sites' GraphQL query in our code: capture the page's own request and replay it.
- Replay headers: the captured ones minus browser-set ones (`:`-pseudo headers, `sec-*`, `user-agent`, `accept-encoding`, `content-length`, `origin`, `priority`, `referer`, `cookie`, `host`, `connection`).
- `PAGE_SIZE = 500` cruises per replayed request; `MAX_PAGES = 20`; `politeDelay()` between requests.
- A line that fails keeps its previous sailings (existing carry-over); failures must be loud.
- Galápagos is its own destination, `galapagos` (Peter, 2026-10-15).
- Synthetic test data inline in test files; `test/fixtures/` holds real captures only.
- Adapters report progress through `onProgress(text)` and never print.
- Commit; never push — Peter pushes. `npm test` runs on Node 24 (`nvm use` first; summary lines start `ℹ`).

## Review Focus

1. **The page sends the search request twice, or sends other GraphQL operations first** — the first `CruisesSearchResults` request is the one replayed; facet queries are ignored. (Task 2 and 3 tests: "captures the first search request only".)
2. **`--limit 5` must not download a 7 MB page** — the replay asks for `min(500, limit)` cruises. (Tasks 2, 3: "limit asks for that many cruises".)
3. **An answer with no `total`** — paging ends on an empty page, and 20 pages without an end fails loudly rather than truncating silently. (Tasks 2, 3.)
4. **A carried-over line's old sailings beyond the window** — trimmed with everything else. (Task 1: "carried-over sailings are trimmed too", through `withinNextYear` applied after carry-over.)
5. **The window's edges** — departing today is out (it has sailed or is sailing), tomorrow in, +365 in, +366 out, across a year boundary. (Task 1.)

---

### Task 1: A rolling 12 months for every line

**Files:**
- Modify: `scrape.js`
- Test: `test/scrape.test.js`

**Interfaces:**
- Produces: `withinNextYear(sailings: object[], today: string /* YYYY-MM-DD */) → { kept: object[], beyond: Record<source, number> }`, exported from `scrape.js`.

- [ ] **Step 1: Write the failing tests** — append to `test/scrape.test.js`, and add `withinNextYear` to its import from `'../scrape.js'`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `nvm use >/dev/null && node --test test/scrape.test.js 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)|does not provide"`
Expected: `SyntaxError … does not provide an export named 'withinNextYear'`.

- [ ] **Step 3: Implement** — in `scrape.js`, after the `plural` helper:

```js
/** The local date, YYYY-MM-DD. */
const localToday = () => new Date().toLocaleDateString('en-CA');

const addDaysIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Every line's horizon: departing after today, up to 365 days ahead (spec 2026-10-15) — a
 * rolling 12 months, moving forward with each scrape. One rule for all six lines, applied
 * to each line's fresh sailings and to any carried over from the previous run.
 */
export function withinNextYear(sailings, today) {
  const until = addDaysIso(today, 365);
  const kept = [];
  const beyond = {};
  for (const s of sailings) {
    if (s.departureDate > today && s.departureDate <= until) kept.push(s);
    else beyond[s.source] = (beyond[s.source] ?? 0) + 1;
  }
  return { kept, beyond };
}
```

Then in `main()`:

1. After `const report = createReporter();` add `const today = localToday();`.
2. In the adapter loop, replace

```js
      const sailings = unique.slice(0, flags.limit);
      if (sailings.length < unique.length) {
        report.log(
          `${adapter.name}: --limit ${flags.limit} truncated ${unique.length} sailings to ${sailings.length}`,
        );
      }
```

with

```js
      const { kept: inYear, beyond } = withinNextYear(unique, today);
      if (beyond[adapter.name]) {
        report.log(`${adapter.name}: left out ${beyond[adapter.name]} sailings outside the next 12 months`);
      }
      const sailings = inYear.slice(0, flags.limit);
      if (sailings.length < inYear.length) {
        report.log(
          `${adapter.name}: --limit ${flags.limit} truncated ${inYear.length} sailings to ${sailings.length}`,
        );
      }
```

3. In the carry-over block, replace `allSailings.push(...carried);` with

```js
  // A previous run may predate the window, or have been scraped months ago: trim it too.
  const { kept: carriedInYear } = withinNextYear(carried, today);
  allSailings.push(...carriedInYear);
```

and in the loop that prints each kept line, count from `carriedInYear` instead of `carried`:
`const n = carriedInYear.filter((s) => s.source === name).length;`

- [ ] **Step 4: Run to verify they pass, then the suite**

Run: `node --test test/scrape.test.js 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0`.
Run: `npm test 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0` (300 tests).

- [ ] **Step 5: Live check, writing nothing**

Run: `node scrape.js --site princess --dry-run 2>&1 | grep -E "princess|DRY RUN"`
Expected: `princess: left out ~97 sailings outside the next 12 months`, `princess: ~98 sailings`, and five "not scraped — kept" lines whose counts are within the window (Holland America ~684, not 760).

- [ ] **Step 6: Commit**

```bash
git add scrape.js test/scrape.test.js
git commit -m "Keep every line to the next 12 months, rolling with each scrape"
```

---

### Task 2: Royal Caribbean reads its whole catalogue

**Files:**
- Modify: `sites/royal-caribbean.js` (constants near `RESULTS_MATCH`; replace `fetchListingPages`; remove `SAILINGS_MARKER`)
- Test: `test/royal-caribbean.test.js`

**Interfaces:**
- Consumes: `parseListing(payload)` (unchanged); `politeDelay`, `detectBotWall` from `../browser.js`; `BotWallError` from `../errors.js`.
- Produces: `fetchListingPages(page, { limit = Infinity, onProgress = () => {}, pause = politeDelay } = {}) → Promise<string[]>` (payload texts, each a full `cruiseSearch` answer); exported `PAGE_SIZE = 500`; exported `replayHeaders(headers) → object`.

- [ ] **Step 1: Write the failing tests** — append to `test/royal-caribbean.test.js`; change its import to
`import { parseListing, parseShip, name, line, fetchListingPages, PAGE_SIZE, replayHeaders } from '../sites/royal-caribbean.js';`
and add `import { BotWallError } from '../errors.js';`:

```js
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
const halves = ({ skip }) => answer(skip === 0 ? cruises.slice(0, 5) : cruises.slice(5), 1000);

test('the fetch replays the page’s own search, 500 cruises at a time, until total', async () => {
  const page = fakePage(halves);
  const payloads = await run(page);
  assert.equal(PAGE_SIZE, 500);
  assert.deepEqual(page.calls.map((c) => c.body.variables.pagination), [{ count: 500, skip: 0 }, { count: 500, skip: 500 }]);
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
  const page = fakePage(() => answer(cruises.slice(0, 1), undefined));
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/royal-caribbean.test.js 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)|does not provide"`
Expected: `does not provide an export named 'PAGE_SIZE'` (or `fetchListingPages` tests failing).

- [ ] **Step 3: Implement** — in `sites/royal-caribbean.js`, delete the `SAILINGS_MARKER` constant and its comment, and add below `RESULTS_MATCH`:

```js
/** The operation whose answer carries sailings; the page sends it as it loads. */
const SEARCH_OPERATION = 'CruisesSearchResults';

/** Cruises per replayed request: 500 answered in ~4 s, ~7.5 MB (spike, 2026-10-15). */
export const PAGE_SIZE = 500;

/** A `total` that never arrives must not page for ever: 20 × 500 = 10,000 cruises. */
const MAX_PAGES = 20;

/** Headers the browser sets for itself; fetch() refuses or ignores them on a replay. */
const BROWSER_HEADERS = /^(:|sec-|user-agent$|accept-encoding$|content-length$|origin$|priority$|referer$|cookie$|host$|connection$)/;

export function replayHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !BROWSER_HEADERS.test(k)));
}

/**
 * One replay of the page's search from inside the page (same-origin, the site's own
 * cookies). HTTP 403, or HTML carrying a block's signature, is a bot wall; anything else
 * that isn't a search answer is an ordinary failure, and fails the line loudly.
 */
async function replay(page, captured, pagination) {
  const body = JSON.stringify({ ...captured.body, variables: { ...captured.body.variables, pagination } });
  const { status, text } = await page.evaluate(async (path, headers, b) => {
    const res = await fetch(path, { method: 'POST', headers, body: b });
    return { status: res.status, text: await res.text() };
  }, captured.path, captured.headers, body);

  if (status === 403) throw new BotWallError('HTTP 403', captured.path);
  const trimmed = String(text ?? '').trimStart();
  if (!trimmed.startsWith('{')) {
    // detectBotWall calls any short body a block; here a short body is just a bad answer.
    const reason = detectBotWall(text);
    if (reason && !reason.startsWith('response too small')) throw new BotWallError(reason, captured.path);
    throw new Error(`Royal Caribbean search answered HTTP ${status} with no JSON: ${trimmed.slice(0, 80) || '(empty)'}`);
  }
  if (status >= 400) throw new Error(`Royal Caribbean search answered HTTP ${status}: ${trimmed.slice(0, 80)}`);
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new Error(`Royal Caribbean search answered invalid JSON: ${trimmed.slice(0, 80)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Royal Caribbean search answered GraphQL errors: ${JSON.stringify(json.errors).slice(0, 120)}`);
  }
  const results = json.data?.cruiseSearch?.results;
  if (!Array.isArray(results?.cruises)) {
    throw new Error(`Royal Caribbean search answer has no results.cruises (skip ${pagination.skip})`);
  }
  return { text: trimmed, results };
}
```

Replace the whole of `fetchListingPages` (and its JSDoc) with:

```js
/**
 * The whole catalogue. The /cruises page asks for its first 10 cruises (`pagination:
 * { count: 10 }`) — the 184 sailings this adapter used to read, of ~3,500. The same request
 * takes `count: 500` and a `skip`: capture the one the page sends, then replay it with
 * bigger pages. No copy of the query lives here — if the site changes it, we replay theirs.
 *
 * @param {import('puppeteer').Page} page
 * @param {{limit?: number, onProgress?: (text: string) => void, pause?: () => Promise<void>}} options
 * @returns {Promise<string[]>} raw JSON answers, each a full cruiseSearch result
 */
export async function fetchListingPages(page, { limit = Infinity, onProgress = () => {}, pause = politeDelay } = {}) {
  let captured = null;
  const onRequest = (request) => {
    if (captured || request.method() !== 'POST' || !request.url().includes(RESULTS_MATCH)) return;
    const raw = request.postData() ?? '';
    if (!raw.includes(SEARCH_OPERATION)) return;
    try {
      captured = { path: new URL(request.url()).pathname, headers: replayHeaders(request.headers()), body: JSON.parse(raw) };
    } catch {
      // Not JSON: keep listening for the next one.
    }
  };

  page.on('request', onRequest);
  try {
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    const wall = detectBotWall(await page.content());
    if (wall) throw new BotWallError(wall, SEARCH_URL);
  } finally {
    page.off('request', onRequest);
  }
  if (!captured) {
    throw new Error('Royal Caribbean: the search page sent no CruisesSearchResults request — the page or its API has changed');
  }

  // `limit` is in sailings; every cruise has at least one, so this many cruises is enough.
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(PAGE_SIZE, limit)) : PAGE_SIZE;
  const payloads = [];
  let sailings = 0;

  for (let n = 0; ; n += 1) {
    if (n === MAX_PAGES) {
      throw new Error(`Royal Caribbean search ran to more than ${MAX_PAGES} pages without an end — stopping rather than guessing`);
    }
    await pause();
    const skip = n * count;
    const { text, results } = await replay(page, captured, { count, skip });
    if (results.cruises.length === 0) break;
    payloads.push(text);

    const total = Number.isFinite(results.total) ? results.total : null;
    onProgress(total === null ? `page ${n + 1}` : `page ${n + 1}/${Math.ceil(total / count)}`);
    sailings += parseListing(text).length;
    if (sailings >= limit) break;
    if (total !== null && skip + count >= total) break;
  }
  return payloads;
}
```

- [ ] **Step 4: Run to verify they pass, then the suite**

Run: `node --test test/royal-caribbean.test.js 2>&1 | grep -E "^✖|^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0`.
Run: `npm test 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0`.

- [ ] **Step 5: Live check, writing nothing**

Run: `node scrape.js --site royal-caribbean --dry-run 2>&1 | grep -E "^royal-caribbean|DRY RUN"`
Expected: `royal-caribbean: left out ~1,480 sailings outside the next 12 months` and `royal-caribbean: ~2,079 sailings (0:1x)` — within ±5% of the spike's 2,079 (the catalogue moves daily).

- [ ] **Step 6: Commit**

```bash
git add sites/royal-caribbean.js test/royal-caribbean.test.js
git commit -m "Read Royal Caribbean's whole catalogue, not the page's first 10 cruises"
```

---

### Task 3: Celebrity reads its whole catalogue

**Files:**
- Modify: `sites/celebrity.js` (same places as Task 2)
- Test: `test/celebrity.test.js`

**Interfaces:**
- Consumes: as Task 2, from `sites/celebrity.js`'s own copies.
- Produces: the same exports as Task 2, in `sites/celebrity.js`: `fetchListingPages`, `PAGE_SIZE`, `replayHeaders`. Never imported from `royal-caribbean.js`.

- [ ] **Step 1: Write the failing tests** — append to `test/celebrity.test.js` the whole test block from Task 2 Step 1, with these changes:
  - import from `'../sites/celebrity.js'`: `import { parseListing, parseShip, shipUrl, name, line, fetchListingPages, PAGE_SIZE, replayHeaders } from '../sites/celebrity.js';` and `import { BotWallError } from '../errors.js';`
  - `PAGE_BODY.variables.filters` is `'voyageType:OCEAN'` (Celebrity's page sends it — its river cruises stay out).
  - `PAGE_HEADERS`: `':authority': 'www.celebritycruises.com'`, `brand: 'C'`, `origin: 'https://www.celebritycruises.com'`; the expected `headers` in the second test has `brand: 'C'`.
  - the fake request's `url` is `'https://www.celebritycruises.com/cruises/graph'`.
  - in "the replay keeps the page’s query…": `assert.equal(body.variables.filters, 'voyageType:OCEAN');`
  - in "captures the first search request only": `second`'s filters is `'voyageType:RIVER'`, and the assertion is `assert.equal(page.calls[0].body.variables.filters, 'voyageType:OCEAN');`
  - in "limit asks for that many cruises": total `479`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/celebrity.test.js 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)|does not provide"`
Expected: `does not provide an export named 'PAGE_SIZE'`.

- [ ] **Step 3: Implement** — in `sites/celebrity.js`, exactly Task 2 Step 3's code (the constants, `replayHeaders`, `replay`, `fetchListingPages`, and removing `SAILINGS_MARKER`), with every message saying `Celebrity` instead of `Royal Caribbean`, and the JSDoc's first lines reading:

```js
/**
 * The whole ocean catalogue. The /cruises page asks for its first 10 cruises — the 114
 * sailings this adapter used to read, of ~1,900 — filtered to `voyageType:OCEAN`. The same
 * request takes `count: 500` and a `skip`: capture the one the page sends (its filter
 * included, so river cruises stay out), then replay it with bigger pages.
```

- [ ] **Step 4: Run to verify they pass, then the suite**

Run: `node --test test/celebrity.test.js 2>&1 | grep -E "^✖|^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0`.
Run: `npm test 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0`.

- [ ] **Step 5: Live check, writing nothing**

Run: `node scrape.js --site celebrity --dry-run 2>&1 | grep -E "^celebrity|DRY RUN"`
Expected: `celebrity: ~838 sailings` (±5%).

- [ ] **Step 6: Commit**

```bash
git add sites/celebrity.js test/celebrity.test.js
git commit -m "Read Celebrity's whole ocean catalogue, not the page's first 10 cruises"
```

---

### Task 4: Galápagos, Transpacific, and the new ports' airports

**Files:**
- Modify: `normalize.js` (`DESTINATIONS`; the destination block in `normalizeAll`, ~line 284)
- Modify: `airports.js` (`AIRPORTS`)
- Test: `test/normalize.test.js`, `test/airports.test.js`

**Interfaces:**
- Consumes: `normalizeAll(rows, { source, line })`, `airportFor(portText)` — unchanged signatures.
- Produces: destinations `galapagos` and `transpacific`.

- [ ] **Step 1: List what is still unrecognised** — the full catalogues bring new labels and ports beyond the spike's list.

Run: `node scrape.js --site royal-caribbean --site celebrity --dry-run > $TMPDIR/rc-cel.log 2>&1; sed -n '/unrecognised value\|with no airport\|skipped/,$p' $TMPDIR/rc-cel.log`
Expected: the spike's list (Galapagos, Transpacific, Repositioning, Pacific Northwest; Tampa, Galveston, New Orleans, Baltimore, Cape Liberty, Shanghai (Baoshan), Seoul (Incheon), Colón, Cartagena, Valparaiso, Baltra Island) and possibly others. Every port listed under "with no airport" gets a row in Step 2's `PORTS` additions and an `AIRPORTS` alias in Step 4, choosing the nearest airport with scheduled international flights, as for the existing entries. Every destination listed gets a mapping by the same rules as Step 2's.

- [ ] **Step 2: Write the failing tests** — append to `test/normalize.test.js`:

```js
test('Royal Caribbean and Celebrity labels from their full catalogues map onto ours', () => {
  const rows = ['Galapagos', 'Galápagos', 'Transpacific', 'Pacific Northwest'].map((destination, i) => ({
    ...goodRow, externalId: `R${i}`, destination,
  }));
  const { sailings, unrecognised } = normalizeAll(rows, { source: 'celebrity', line: 'Celebrity Cruises' });
  assert.deepEqual(sailings.map((s) => s.destination), ['galapagos', 'galapagos', 'transpacific', 'pacific-coast']);
  assert.equal(unrecognised.filter((u) => u.field === 'destination').length, 0);
});

test('"Repositioning" takes its region from the itinerary name, or stays on the to-do list', () => {
  const rows = [
    { ...goodRow, externalId: 'P1', destination: 'Repositioning', itinerary: '12 Night Transpacific Repositioning' },
    { ...goodRow, externalId: 'P2', destination: 'Repositioning', itinerary: '6 Night Repositioning Cruise' },
  ];
  const { sailings, unrecognised } = normalizeAll(rows, { source: 'royal-caribbean', line: 'Royal Caribbean' });
  assert.deepEqual(sailings.map((s) => s.destination), ['transpacific', null]);
  assert.deepEqual(unrecognised.filter((u) => u.field === 'destination'), [{ field: 'destination', raw: 'Repositioning', count: 1 }]);
});
```

and in `test/airports.test.js`, add to the `PORTS` table (after the Viking line):

```js
  // Royal Caribbean and Celebrity's full catalogues, 2026-10-15.
  'Tampa': 'TPA', 'Galveston': 'IAH', 'New Orleans': 'MSY', 'Baltimore': 'BWI',
  'Cape Liberty': 'EWR', 'Shanghai (Baoshan)': 'PVG', 'Seoul (Incheon)': 'ICN', 'Colón': 'PTY',
  'Cartagena': 'CTG', 'Valparaiso': 'SCL', 'Baltra Island': 'GPS',
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/normalize.test.js test/airports.test.js 2>&1 | grep -E "^✖|^(ℹ|#) (tests|pass|fail)" | sort -u`
Expected: the two new normalize tests and `every known port maps to its airport` fail.

- [ ] **Step 4: Implement**

In `normalize.js` `DESTINATIONS`: add `'pacific northwest'` to the `'pacific-coast'` list, and after `'africa'`:

```js
  // Celebrity sails the Galápagos from Baltra (Peter, 2026-10-15: its own destination).
  // key() drops accented letters, so the accented spelling is listed as well.
  'galapagos': ['galapagos', 'galápagos', 'galapagos islands'],
  // Royal Caribbean and Celebrity's Asia ↔ Alaska/Hawaii/Australia crossings.
  'transpacific': ['transpacific', 'trans pacific'],
```

In `normalizeAll`, replace

```js
      sailing.destination =
        canonicalDestination(row.destination) ?? findDestination(row.destination);
```

with

```js
      // "Repositioning" names no region; the itinerary's name often does
      // ("12 Night Transpacific Repositioning"). Otherwise it stays on the to-do list.
      sailing.destination =
        canonicalDestination(row.destination) ?? findDestination(row.destination)
        ?? (row.itinerary ? findDestination(row.itinerary) : null);
```

In `airports.js` `AIRPORTS`: add `'valparaiso'` to `SCL`, `'colon'` to `PTY` (Colón is ~80 km from Panama City), and new entries:

```js
  TPA: ['Tampa', 'tampa'],
  // Galveston's nearest airline airport is Houston Intercontinental, ~75 km away.
  IAH: ['Houston', 'houston', 'galveston'],
  MSY: ['New Orleans', 'new orleans'],
  BWI: ['Baltimore', 'baltimore'],
  // Cape Liberty is Bayonne, New Jersey: Newark is closest.
  EWR: ['Newark', 'newark', 'cape liberty', 'bayonne'],
  PVG: ['Shanghai', 'shanghai'],
  ICN: ['Seoul', 'seoul', 'incheon'],
  // Cartagena, Colombia — Royal Caribbean sails from it. (Spain's Cartagena is a port of
  // call, never a departure, so it never reaches the airport lookup.)
  CTG: ['Cartagena', 'cartagena'],
  // Baltra Island is the Galápagos airport (Seymour).
  GPS: ['Galápagos (Baltra)', 'baltra', 'baltra island'],
```

plus one entry or alias per extra port Step 1 listed.

- [ ] **Step 5: Run to verify they pass, then the suite**

Run: `node --test test/normalize.test.js test/airports.test.js 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0`.
Run: `npm test 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0`.

- [ ] **Step 6: Live check** — re-run Step 1's command.
Expected: no `unrecognised value` or `with no airport` headings (only Princess-style skipped sailings, if any).

- [ ] **Step 7: Commit**

```bash
git add normalize.js airports.js test/normalize.test.js test/airports.test.js
git commit -m "Map Galápagos, Transpacific and the new ports from the full catalogues"
```

---

### Task 5: The whole scrape, and the project notes

**Files:**
- Modify: `CLAUDE.md` (Status counts and test count; the "Celebrity and Royal Caribbean read one results page each" paragraph; a horizon note)
- Modify: `README.md` only if it states line counts or "one results page" (check with `grep -n "184\|one results page\|sailings" README.md`)

- [ ] **Step 1: A dry run of every line, writing nothing**

Run: `node scrape.js --dry-run > $TMPDIR/full.log 2>&1; grep -E "sailings \(|left out|DRY RUN|unrecognised|no airport|Done in" $TMPDIR/full.log`
Expected: Royal Caribbean ~2,079, Celebrity ~838, Princess ~98, Holland America ~684, Viking ~326, Cunard ~276; `DRY RUN — ~4,300 sailings`; no unrecognised values or airportless ports (fix any per Task 4 and commit there). Takes ~20 minutes.

- [ ] **Step 2: Update `CLAUDE.md`**

- Replace the paragraph starting `**Celebrity and Royal Caribbean read one results page each**` with:

```markdown
**Royal Caribbean and Celebrity read their whole catalogues** (spec:
`docs/superpowers/specs/2026-10-15-full-catalogues-design.md`). Their `/cruises` page asks for
its first 10 cruises; the adapters capture that request and replay it from inside the page
with `pagination: { count: 500, skip }` — 3 requests for Royal Caribbean (~1,190 cruises),
2 for Celebrity (~640, ocean only: the page's own `voyageType:OCEAN` filter is kept). No copy
of their GraphQL query lives in our code. Before 2026-10-15 they read the 10 cruises alone,
and coverage drifted: Celebrity's 36 Alaska sailings vanished between two scrapes.

**Every line keeps the next 12 months** — departing after today, up to 365 days ahead,
rolling forward with each scrape. One rule, `withinNextYear` in `scrape.js`, applied to each
line's fresh sailings and to any carried over. Holland America's 750 cap still applies first.
```

- In **Status**: the line counts and total from Step 1, Alaska's new count
  (`node -e` over the dry-run isn't possible — use the counts Step 1 printed, and after Peter's
  full scrape, recount Alaska with
  `node -e 'const d=JSON.parse(require("fs").readFileSync("data/sailings.json"));console.log(d.sailings.filter(s=>s.destination==="alaska").length)'`),
  and the test count from `npm test`.
- In the **Lazy loading** paragraph, replace "Every Royal Caribbean card shows one of two
  photos … asking per destination would vary them." with "Royal Caribbean's cards now show
  ~90 different photos."

- [ ] **Step 3: Run the suite**

Run: `npm test 2>&1 | grep -E "^(ℹ|#) (tests|pass|fail)"` → `ℹ fail 0`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Record the full catalogues and the 12-month horizon in the project notes"
```

Peter's live check, after the branch is reviewed: a full `node scrape.js` (~20 min), then the
page: Alaska shows Royal Caribbean and Celebrity sailings, Royal Caribbean's photos vary,
Galápagos is in the destination list, and nothing is dated beyond a year from the scrape.
