# Holland America Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Holland America's Alaska sailings — plain cruises and cruisetours — as the fourth cruise line, with cruisetours flagged by a new `tripType` field that search and the page both understand.

**Architecture:** A new standalone adapter, `sites/holland-america.js`, reads the site's Solr search API page by page (not the rendered page). A new `tripType` field flows through the existing pipeline: `normalize.js` defaults it to `"cruise"` so the other three adapters need no change, `values.js` enumerates it, `brain.js` lets the model filter on it, `search.js` applies it, and `public/index.html` labels cruisetour cards.

**Tech Stack:** Node 22 (ESM), Puppeteer, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-holland-america-design.md` — read it first. It records why each decision was made and what the evidence showed.

## Global Constraints

- Node 22, ESM. Dependencies stay `puppeteer` and `@anthropic-ai/sdk` only. No new packages.
- Adapters are standalone files. Never import one adapter from another, never add a shared base.
- Alaska only: `fq=destinationIds:A`.
- Currency USD: `country=us`.
- Cap: **450** sailings, earliest departure first.
- Price: the lowest `price_<CUR>_<XX>_FLEXIBLE_d` value greater than zero, where `<XX>` is a two-letter cabin code. Never read promo-code keys or `launch_price_*`.
- `tripType` is exactly `"cruise"` or `"cruisetour"`. Missing means `"cruise"`.
- Sailing ID: `` `${cruiseId}_${tourId || 'cruise'}` ``.
- `shipDescriptions = false` for this adapter: its ship pages carry no usable description (spec, step 1 findings).
- Politeness: sequential requests, `politeDelay()` between pages.
- Synthetic test data lives inline in test files, never in `test/fixtures/`. Fixtures are real captured payloads.
- This project has no git remote. Commit; never push.

## Review Focus

Inputs and conditions the spec implies but does not spell out, most likely to bite first. Each has a test in the task named.

1. **A page boundary falls inside a run of sailings on the same date.** With a sort on date alone, the API may order ties differently per request, repeating or skipping rows. Expected: a secondary sort makes order stable, and any repeat is removed by the existing `dedupeById`. → Task 3 (live check: no duplicate or conflicting-duplicate messages).
2. **The response arrives without `facets`.** Expected: the destination falls back to the raw code (`"A"`), which `normalize.js` reports as unrecognised — visible, not silently dropped. → Task 2.
3. **A data file scraped before this change** (no `tripType` field) **meets a `tripType` filter.** Expected: a missing `tripType` counts as `"cruise"`, so "cruises only" still finds those sailings. → Task 4.
4. **A search that says only "show me cruisetours".** Expected: `tripType` alone counts as a real constraint; the "understood nothing" guard must not fire and return nothing. → Task 4.
5. **An unexpected `cruiseType` value from the API.** Expected: reported in `unrecognised`, never silently treated as a cruise or a cruisetour. → Tasks 1 and 2.

---

### Task 1: `tripType` in normalize and values

**Files:**
- Modify: `normalize.js` (the `sailing` object in `normalizeAll`, ~line 193)
- Modify: `values.js` (`deriveValues`)
- Test: `test/normalize.test.js`, `test/values.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: every normalized sailing has `tripType: 'cruise' | 'cruisetour' | null` (`null` only for an unrecognised value, which is also reported). `deriveValues(sailings).tripType` is a sorted unique string array.

- [ ] **Step 1: Write the failing tests**

In `test/normalize.test.js`, the test `'a good row becomes a fully canonical Sailing'` compares the whole object. Add `tripType: 'cruise',` to its expected object, directly after `currency: 'USD',`.

Then add these tests at the end of the file:

```js
// tripType is how a cruisetour (cruise plus land days, sold as one package) is told
// apart from a plain cruise. Adapters that sell only cruises never set it.
test('tripType defaults to cruise when an adapter does not set it', () => {
  const { sailings } = normalizeAll([goodRow], { source: 'princess', line: 'Princess' });
  assert.equal(sailings[0].tripType, 'cruise');
});

test('a cruisetour keeps its tripType', () => {
  const row = { ...goodRow, tripType: 'cruisetour' };
  const { sailings } = normalizeAll([row], { source: 'holland-america', line: 'Holland America' });
  assert.equal(sailings[0].tripType, 'cruisetour');
});

test('an unknown tripType is reported and the sailing is kept', () => {
  const row = { ...goodRow, tripType: 'RIVER_FIRST' };
  const { sailings, unrecognised } = normalizeAll([row], { source: 'holland-america', line: 'Holland America' });
  assert.equal(sailings.length, 1);
  assert.equal(sailings[0].tripType, null);
  assert.deepEqual(unrecognised, [{ field: 'tripType', raw: 'RIVER_FIRST', count: 1 }]);
});
```

In `test/values.test.js`, add:

```js
test('tripType is enumerated, with sailings that lack it counted as cruises', () => {
  const values = deriveValues([
    { ...sailings[0], tripType: 'cruisetour' },
    { ...sailings[1], tripType: 'cruise' },
    sailings[2], // no tripType: scraped before the field existed
  ]);
  assert.deepEqual(values.tripType, ['cruise', 'cruisetour']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/normalize.test.js test/values.test.js`
Expected: FAIL — the canonical-Sailing test reports a missing `tripType` key; the new tests report `undefined` where `'cruise'` / `['cruise', 'cruisetour']` was expected.

- [ ] **Step 3: Implement**

In `normalize.js`, add a constant near `REQUIRED`:

```js
/** A cruisetour is a cruise plus land days sold as one package (Holland America). */
const TRIP_TYPES = ['cruise', 'cruisetour'];
```

In `normalizeAll`, add to the `sailing` object directly after `currency: row.currency ?? 'USD',`:

```js
      // Adapters that sell only plain cruises never set this, so absent means cruise.
      tripType: row.tripType ?? 'cruise',
```

And directly after the `if (row.cabin) { … }` block:

```js
    if (!TRIP_TYPES.includes(sailing.tripType)) {
      miss('tripType', String(sailing.tripType));
      sailing.tripType = null;
    }
```

In `values.js`, add to the object returned by `deriveValues`:

```js
    // A sailing scraped before tripType existed is a plain cruise.
    tripType: uniqueSortedStrings(sailings.map((s) => s.tripType ?? 'cruise')),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass — 116 tests (112 before this task, plus 4 new).

- [ ] **Step 5: Commit**

```bash
git add normalize.js values.js test/normalize.test.js test/values.test.js
git commit -m "Add tripType to every sailing, defaulting to cruise"
```

---

### Task 2: Parse Holland America's search response

**Files:**
- Create: `sites/holland-america.js`
- Modify: `normalize.js` (`CABINS.suite` aliases)
- Test: `test/holland-america.test.js` (new)

**Interfaces:**
- Consumes: `normalizeAll` (Task 1) in one test.
- Produces, from `sites/holland-america.js`:
  - `name = 'holland-america'`, `line = 'Holland America'`, `shipDescriptions = false`
  - `unpack(packed: string): { value: string|null, code: string|null }`
  - `cheapestFlexible(doc: object): { price: number, currency: string, cabinCode: string } | null`
  - `parseListing(payload: string): RawSailing[]`
  - `parseShip(): { line, description: '', source: null }`
  - `shipUrl(ship: string): string`

Tests run against the **existing** CAD fixture, `test/fixtures/holland-america-search.json`. That is deliberate: it proves the parser reads the currency from the key rather than assuming USD. The USD fixture is captured in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `test/holland-america.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseListing, parseShip, cheapestFlexible, unpack, name, line, shipDescriptions,
} from '../sites/holland-america.js';
import { normalizeAll } from '../normalize.js';

// Captured 2026-08-05 with country=ca, all destinations. Its prices are CAD.
const cadPayload = await readFile(
  new URL('./fixtures/holland-america-search.json', import.meta.url), 'utf8',
);

test('the adapter identifies itself', () => {
  assert.equal(name, 'holland-america');
  assert.equal(line, 'Holland America');
});

test('the adapter declares it supplies no ship descriptions', () => {
  // /cruise-ships/<name> is a client-rendered shell with no description in it.
  assert.equal(shipDescriptions, false);
  assert.equal(parseShip('<html></html>').description, '');
});

test('#@# packs a value and a code; unpack splits them', () => {
  assert.deepEqual(unpack('Westerdam#@#WE'), { value: 'Westerdam', code: 'WE' });
  assert.deepEqual(unpack('Vancouver, B.C., CA#@#YVR'), { value: 'Vancouver, B.C., CA', code: 'YVR' });
  assert.deepEqual(unpack('Whittier, Alaska, US'), { value: 'Whittier, Alaska, US', code: null });
  assert.deepEqual(unpack(undefined), { value: null, code: null });
});

test('one row per doc, with unique IDs', () => {
  const rows = parseListing(cadPayload);
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((r) => r.externalId)).size, 20);
});

test('the first row reads as the captured sailing', () => {
  assert.deepEqual(parseListing(cadPayload)[0], {
    externalId: 'W656_cruise',
    url: 'https://www.hollandamerica.com/en/us/find-a-cruise/a6n07b/w656',
    ship: 'Westerdam',
    departurePort: 'Vancouver, B.C., CA',
    destination: 'ALASKA',
    departureDate: '2026-08-16',
    nights: 7,
    tripType: 'cruise',
    cabin: 'Inside',
    price: 1799,
    currency: 'CAD',
    itinerary: '7-DAY GLACIER DISCOVERY NORTHBOUND',
    image: null,
    ports: [],
  });
});

test('the price is the cheapest refundable fare, never a promo code or launch price', () => {
  // Synthetic: every cheaper number on this row is one the rule must ignore.
  const doc = {
    price_USD_IN_FLEXIBLE_d: 1449,
    price_USD_OV_FLEXIBLE_d: 1599,
    price_USD_VN_FLEXIBLE_d: 0, // 0 means not available
    price_USD_SS_FLEXIBLE_d: -1, // -1 means not available
    price_USD_IN_RESTRICTED_d: 999, // non-refundable: not the chosen fare type
    price_USD_HEP2614AK_d: 649, // promo code
    price_USD_FLEXIBLE: 900, // a summary key without a cabin code
    launch_price_USD_IN_FLEXIBLE_d: 500, // the "was" price
  };
  assert.deepEqual(cheapestFlexible(doc), { price: 1449, currency: 'USD', cabinCode: 'IN' });
});

test('a sailing with no refundable fare has no price', () => {
  assert.equal(cheapestFlexible({ price_USD_IN_RESTRICTED_d: 999 }), null);
});

test('cruisetours are told apart from cruises, and an unknown type passes through', () => {
  const payload = JSON.stringify({
    response: {
      docs: [
        { cruiseId: 'W729', tourId: 'T7ADAL', cruiseType: 'LAND_FIRST', price_USD_IN_FLEXIBLE_d: 3939 },
        { cruiseId: 'W728', tourId: 'T7AD9C', cruiseType: 'SEA_FIRST', price_USD_IN_FLEXIBLE_d: 2609 },
        { cruiseId: 'W728', tourId: '', cruiseType: '', price_USD_IN_FLEXIBLE_d: 1449 },
        { cruiseId: 'X1', tourId: 'T1', cruiseType: 'RIVER_FIRST', price_USD_IN_FLEXIBLE_d: 1 },
      ],
    },
  });
  const rows = parseListing(payload);
  assert.deepEqual(rows.map((r) => r.tripType), ['cruisetour', 'cruisetour', 'cruise', 'RIVER_FIRST']);
  // One cruise sold as a cruise and as a package is two sailings, not a duplicate.
  assert.deepEqual(rows.map((r) => r.externalId), ['W729_T7ADAL', 'W728_T7AD9C', 'W728_cruise', 'X1_T1']);
});

test('without facets, the destination falls back to the raw code', () => {
  const payload = JSON.stringify({
    response: { docs: [{ cruiseId: 'A1', destinationIds: ['A'], price_USD_IN_FLEXIBLE_d: 100 }] },
  });
  assert.equal(parseListing(payload)[0].destination, 'A');
});

test('a payload without docs parses to nothing rather than throwing', () => {
  assert.deepEqual(parseListing('{}'), []);
});

test('rows normalize: unpriced sailings are dropped, every cabin label is known', () => {
  const { sailings, unrecognised } = normalizeAll(parseListing(cadPayload), {
    source: 'holland-america', line: 'Holland America',
  });
  assert.equal(sailings.length, 16); // 4 docs carry no price keys at all
  assert.deepEqual(unrecognised.filter((u) => u.field !== 'row'), []);
  assert.equal(sailings[0].destination, 'alaska');
  assert.equal(sailings[0].cabin, 'interior');
  assert.equal(sailings[0].tripType, 'cruise');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/holland-america.test.js`
Expected: FAIL — `Cannot find module '../sites/holland-america.js'`.

- [ ] **Step 3: Implement the adapter's parsing half**

Create `sites/holland-america.js`:

```js
/**
 * Holland America adapter. Knows about hollandamerica.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 *
 * Reads the site's own search API (a Solr endpoint) rather than the rendered page.
 * See docs/superpowers/specs/2026-10-02-holland-america-design.md for what the
 * response looks like and why each rule below is what it is.
 */

import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

export const name = 'holland-america';
export const line = 'Holland America';

const SITE_ORIGIN = 'https://www.hollandamerica.com';

/**
 * The API packs two values into one string: "Westerdam#@#WE" is a ship name and
 * its code. Split on the marker; a regex around it would break on the first name
 * that contains a character the regex did not expect.
 *
 * @param {string} packed
 * @returns {{value: string|null, code: string|null}}
 */
export function unpack(packed) {
  const [value, code = null] = String(packed ?? '').split('#@#');
  return { value: value.trim() || null, code };
}

// price_<currency>_<two-letter cabin code>_FLEXIBLE_d. The pattern is the rule:
// it excludes RESTRICTED and "anonymous" fares, every promo-code key
// (price_USD_HEP2614AK_d), the cabinless summary keys (price_USD_FLEXIBLE), and
// launch_price_*, which is the "was" price.
const FLEXIBLE_PRICE = /^price_(USD|CAD)_([A-Z]{2})_FLEXIBLE_d$/;

/**
 * The cheapest refundable fare on a sailing. -1 and 0 mean "not available".
 *
 * @param {object} doc - one row of response.docs
 * @returns {{price: number, currency: string, cabinCode: string}|null}
 */
export function cheapestFlexible(doc) {
  let best = null;
  for (const [key, value] of Object.entries(doc)) {
    const match = key.match(FLEXIBLE_PRICE);
    if (!match || typeof value !== 'number' || value <= 0) continue;
    if (!best || value < best.price) {
      best = { price: value, currency: match[1], cabinCode: match[2] };
    }
  }
  return best;
}

/** "Inside#@#WE_IN" -> { IN: 'Inside' }: the site's own name for each cabin code. */
function cabinLabels(meta) {
  const labels = {};
  for (const entry of meta ?? []) {
    const { value, code } = unpack(entry);
    const cabinCode = code?.split('_').pop();
    if (value && cabinCode) labels[cabinCode] = value;
  }
  return labels;
}

/** "ALASKA#@#A" -> { A: 'ALASKA' }, from the facets in the same response. */
function destinationNames(facets) {
  const names = {};
  for (const bucket of facets?.destinations?.buckets ?? []) {
    const { value, code } = unpack(bucket.val);
    if (value && code) names[code] = value;
  }
  return names;
}

/**
 * A cruisetour is a cruise plus land days sold as one package. Anything other than
 * the three values seen is passed through raw, so normalize.js reports it.
 */
function tripTypeOf(cruiseType) {
  if (!cruiseType) return 'cruise';
  if (cruiseType === 'LAND_FIRST' || cruiseType === 'SEA_FIRST') return 'cruisetour';
  return cruiseType;
}

/**
 * @param {string} payload - raw JSON text of one halcruisesearch response
 * @returns {object[]} RawSailing rows, one per doc
 */
export function parseListing(payload) {
  const data = JSON.parse(payload);
  const docs = data?.response?.docs;
  if (!Array.isArray(docs)) return [];

  const destinations = destinationNames(data.facets);
  const rows = [];

  for (const doc of docs) {
    const fare = cheapestFlexible(doc);
    const labels = cabinLabels(doc.meta);
    const destinationCode = doc.destinationIds?.[0] ?? null;

    rows.push({
      // One cruise on one date is sold as several cruisetour packages, each with its
      // own price and page — cruiseId alone would merge them.
      externalId: `${doc.cruiseId}_${doc.tourId || 'cruise'}`,
      url: doc.contentPath ? `${SITE_ORIGIN}/en/us${doc.contentPath}` : null,
      ship: unpack(doc.shipName).value,
      departurePort: unpack(doc.embarkPortName).value,
      // A missing facets table leaves the raw code, which normalize.js reports.
      destination: destinations[destinationCode] ?? destinationCode,
      departureDate: doc.departDate ? doc.departDate.slice(0, 10) : null,
      // For a cruisetour this is the whole package, land days included.
      nights: doc.duration ?? null,
      tripType: tripTypeOf(doc.cruiseType),
      cabin: fare ? (labels[fare.cabinCode] ?? fare.cabinCode) : null,
      price: fare?.price ?? null,
      currency: fare?.currency ?? null,
      itinerary: doc.name ?? null,
      image: null,
      ports: [],
    });
  }

  return rows;
}

/**
 * Ship pages carry no usable description: /cruise-ships/<name> is a client-rendered
 * shell, and the only server-rendered text (a deck-plans tab) describes deck plans,
 * not the ship. A missing description is visible; a wrong one is not.
 *
 * @returns {{line: string, description: string, source: null}}
 */
export function parseShip() {
  return { line, description: '', source: null };
}

/** Tells scrape.js not to fetch ship pages at all, for the reason above. */
export const shipDescriptions = false;

export function shipUrl(ship) {
  const slug = String(ship).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${SITE_ORIGIN}/en/us/cruise-ships/${slug}`;
}
```

The imports of `politeDelay`, `detectBotWall` and `BotWallError` are used in Task 3; leaving them now keeps the file's header stable.

In `normalize.js`, extend `CABINS.suite` with Holland America's suite names:

```js
  // Holland America names each suite tier; a Vista Suite is its largest verandah
  // category, sold as a suite.
  suite: [
    'suite', 'mini suite', 'minisuite', 'junior suite', 'owners suite', 'penthouse', 'deluxe',
    'vista suite', 'neptune suite', 'pinnacle suite', 'signature suite',
  ],
```

Holland America's other labels already map: `Inside` → interior, `Ocean View` → oceanview, `Verandah` → balcony. **Lanai is deliberately not mapped** (spec, section 1): its door opens onto the promenade, not a private balcony, so it stays unrecognised until seen in real data.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/holland-america.test.js && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add sites/holland-america.js normalize.js test/holland-america.test.js
git commit -m "Parse Holland America search responses into sailings"
```

---

### Task 3: Fetch, register, capture the USD fixture, and check live

**Files:**
- Modify: `sites/holland-america.js` (add `searchUrl`, `fetchListingPages`, `fetchShipPage`)
- Modify: `sites/index.js` (register)
- Modify: `test/scrape.test.js` (adapter list)
- Create: `test/fixtures/holland-america-alaska-us.json` (captured), `test/fixtures/holland-america-first-row.json` (hand-checked)
- Modify: `test/fixtures/NOTES.md` (capture log)
- Test: `test/holland-america.test.js`

**Interfaces:**
- Consumes: `parseListing` (Task 2), `politeDelay`, `detectBotWall` from `browser.js`, `BotWallError` from `errors.js`.
- Produces: `searchUrl(start: number): string`, `fetchListingPages(page, { limit }): Promise<string[]>`, `fetchShipPage(page, ship): Promise<string>`; `'holland-america'` in `ADAPTERS`.

- [ ] **Step 1: Write the failing tests**

Add to `test/holland-america.test.js` (and add `searchUrl` to its import list):

```js
test('the search URL asks for Alaska, in USD, unsold, earliest first, 20 at a time', () => {
  const url = new URL(searchUrl(40));
  const p = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://www.hollandamerica.com/search/halcruisesearch');
  assert.equal(p.get('start'), '40');
  assert.equal(p.get('rows'), '20');
  assert.equal(p.get('country'), 'us');
  assert.equal(p.get('sort'), 'departDate asc,cruiseId asc,tourId asc');
  assert.deepEqual(p.getAll('fq'), [
    'departDate:[NOW/DAY+1DAY TO *]', 'destinationIds:A', 'soldOut:false',
  ]);
  assert.match(p.get('fl'), /price_USD_\*/);
  assert.doesNotMatch(p.get('fl'), /launch_price/);
});
```

In `test/scrape.test.js`, update both adapter lists to end with `'holland-america'`:

```js
  assert.deepEqual(ADAPTERS.map((a) => a.name), ['royal-caribbean', 'celebrity', 'princess', 'holland-america']);
```

```js
  assert.deepEqual(adaptersFor([]).map((a) => a.name), ['royal-caribbean', 'celebrity', 'princess', 'holland-america']);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/holland-america.test.js test/scrape.test.js`
Expected: FAIL — `searchUrl` is not exported; the adapter lists lack `holland-america`.

- [ ] **Step 3: Implement fetching and register the adapter**

Add to `sites/holland-america.js`, after `SITE_ORIGIN`:

```js
const SEARCH_URL = `${SITE_ORIGIN}/search/halcruisesearch`;
const PAGE_ROWS = 20;

/**
 * Alaska alone is ~859 dated sailings, ~430 a season. 450 covers the next season;
 * raise it here to take more.
 */
const CAP = 450;

// cruiseId and tourId break ties within a date, so the order is the same on every
// request and a page boundary never repeats or skips a sailing.
const SORT = 'departDate asc,cruiseId asc,tourId asc';
const FILTERS = ['departDate:[NOW/DAY+1DAY TO *]', 'destinationIds:A', 'soldOut:false'];
const FIELDS = [
  'cruiseId', 'tourId', 'itineraryId', 'shipName', 'embarkPortName', 'departDate',
  'duration', 'name', 'cruiseType', 'destinationIds', 'contentPath', 'meta', 'price_USD_*',
].join(',');

/**
 * @param {number} start - zero-based row offset
 * @returns {string}
 */
export function searchUrl(start) {
  const params = new URLSearchParams({
    start: String(start), rows: String(PAGE_ROWS), country: 'us', language: 'en', sort: SORT,
  });
  for (const fq of FILTERS) params.append('fq', fq);
  params.set('fl', FIELDS);
  return `${SEARCH_URL}?${params}`;
}
```

Add after `parseListing`:

```js
/**
 * Pages through the search API until the cap, the limit, or a short page.
 *
 * @param {import('puppeteer').Page} page
 * @param {{limit: number}} options - caps rows fetched, below CAP
 * @returns {Promise<string[]>} raw JSON text, one per page
 */
export async function fetchListingPages(page, { limit }) {
  const wanted = Math.min(CAP, Number.isFinite(limit) ? limit : CAP);
  const payloads = [];

  for (let start = 0; start < wanted; start += PAGE_ROWS) {
    const url = searchUrl(start);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const body = await response.text();

    const wall = detectBotWall(body);
    if (wall) throw new BotWallError(wall, url);
    payloads.push(body);

    const got = JSON.parse(body)?.response?.docs?.length ?? 0;
    if (got < PAGE_ROWS) break;
    await politeDelay();
  }

  return payloads;
}

/**
 * Never called by scrape.js (shipDescriptions is false); kept so the adapter
 * satisfies the contract, and as the starting point if a usable page is found.
 */
export async function fetchShipPage(page, ship) {
  const url = shipUrl(ship);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await politeDelay();
  const html = await page.content();
  const wall = detectBotWall(html);
  if (wall) throw new BotWallError(wall, url);
  return html;
}
```

In `sites/index.js`:

```js
import * as royalCaribbean from './royal-caribbean.js';
import * as celebrity from './celebrity.js';
import * as princess from './princess.js';
import * as hollandAmerica from './holland-america.js';

// Royal Caribbean, Celebrity and Holland America read a JSON API; Princess parses
// the rendered results page, because its API cannot produce a dated price. Each
// adapter is a standalone file on purpose — when one site changes shape, the
// others keep running.
export const ADAPTERS = [royalCaribbean, celebrity, princess, hollandAmerica];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass, including `'every adapter satisfies the contract'`.

- [ ] **Step 5: Capture the USD Alaska fixture**

This is one live request. Run:

```bash
node tools/capture-fixture.js \
  --url "$(node -e 'import("./sites/holland-america.js").then(m => console.log(m.searchUrl(0)))')" \
  --match halcruisesearch --out test/fixtures/holland-america-alaska-us.json
```

Expected: the tool reports one saved response. Check it:

```bash
node -e 'const j=require("./test/fixtures/holland-america-alaska-us.json"); const d=j.response.docs; console.log(j.response.numFound, d.length, d.map(x=>x.departDate.slice(0,10)).join(" "), d.map(x=>x.cruiseType||"-").join(" "))'
```

Expected: `numFound` in the 800s, 20 docs, dates ascending, and a mix of `-` (cruise) and `LAND_FIRST`/`SEA_FIRST`. If the request errors on the three-field `sort`, change `SORT` to `'departDate asc'`, note it in the adapter comment, and rely on `dedupeById` for repeats.

- [ ] **Step 6: Check one price against the live site — Peter does this**

```bash
node -e 'import("./sites/holland-america.js").then(async m => { const fs = await import("node:fs"); const r = m.parseListing(fs.readFileSync("test/fixtures/holland-america-alaska-us.json","utf8"))[0]; console.log(r.url, "\n", r.cabin, r.currency, r.price, r.tripType) })'
```

Open the printed URL. Choose the **refundable** fare for the printed cabin. Expected: the site's price matches the printed price. **If it does not match, stop** — the price rule is wrong and Tasks 4–6 must wait until the mismatch is understood.

- [ ] **Step 7: Write the golden first row and its test**

Print the first parsed row:

```bash
node -e 'import("./sites/holland-america.js").then(async m => { const fs = await import("node:fs"); console.log(JSON.stringify(m.parseListing(fs.readFileSync("test/fixtures/holland-america-alaska-us.json","utf8"))[0], null, 2)) })'
```

Check every field by hand against `response.docs[0]` in the fixture and the page from Step 6, then save it as `test/fixtures/holland-america-first-row.json`. Add to `test/holland-america.test.js`:

```js
const usPayload = await readFile(
  new URL('./fixtures/holland-america-alaska-us.json', import.meta.url), 'utf8',
);
const golden = JSON.parse(
  await readFile(new URL('./fixtures/holland-america-first-row.json', import.meta.url), 'utf8'),
);

test('the USD Alaska capture matches its hand-checked first row', () => {
  assert.deepEqual(parseListing(usPayload)[0], golden);
});

test('every USD Alaska row normalizes to Alaska, in USD, with a known trip type', () => {
  const { sailings, unrecognised } = normalizeAll(parseListing(usPayload), {
    source: 'holland-america', line: 'Holland America',
  });
  assert.ok(sailings.length > 0);
  for (const s of sailings) {
    assert.equal(s.destination, 'alaska', s.id);
    assert.equal(s.currency, 'USD', s.id);
    assert.ok(['cruise', 'cruisetour'].includes(s.tripType), s.id);
  }
  assert.deepEqual(unrecognised.filter((u) => u.field !== 'row'), []);
});
```

Run: `npm test`
Expected: all pass. If `Lanai` appears in `unrecognised`, stop and ask Peter how to map it rather than guessing.

- [ ] **Step 8: Small live dry run**

```bash
node scrape.js --site holland-america --limit 40 --dry-run; echo "exit: $?"
```

Expected: `holland-america: 40 sailings` (or close), **exit 0**, no `BOT WALL`, no `dropped N duplicate` line, no `ConflictingDuplicateError`, no unrecognised values. Two page requests.

- [ ] **Step 9: Record the capture and commit**

Append a `# Holland America` section to `test/fixtures/NOTES.md` recording: the capture date, the exact `searchUrl(0)`, `numFound`, the Step 6 price check result (sailing, cabin, both prices), and the Step 8 dry-run result.

```bash
git add sites/holland-america.js sites/index.js test/scrape.test.js test/holland-america.test.js \
  test/fixtures/holland-america-alaska-us.json test/fixtures/holland-america-first-row.json test/fixtures/NOTES.md
git commit -m "Fetch Holland America's Alaska sailings and register the adapter"
```

---

### Task 4: Search and the model understand `tripType`

**Files:**
- Modify: `search.js` (`searchSailings`, `CONSTRAINTS`, `describeFilter`)
- Modify: `brain.js` (`buildSchema`, `buildSystemPrompt`)
- Test: `test/search.test.js`, `test/brain.test.js` (new)

**Interfaces:**
- Consumes: `values.tripType` (Task 1).
- Produces: `filter.tripType: 'cruise' | 'cruisetour' | null` accepted by `searchSailings`, `hasNoConstraints`, `describeFilter`; `buildSchema(values).properties.tripType`.

- [ ] **Step 1: Write the failing tests**

Add to `test/search.test.js`:

```js
test('tripType filters, and a sailing without one counts as a cruise', () => {
  const mixed = [
    { ...sailings[0], tripType: 'cruisetour' },
    { ...sailings[1], tripType: 'cruise' },
    sailings[2], // scraped before tripType existed
  ];
  assert.equal(searchSailings(mixed, { tripType: 'cruisetour' }).length, 1);
  assert.equal(searchSailings(mixed, { tripType: 'cruise' }).length, 2);
  assert.equal(searchSailings(mixed, {}).length, 3);
});

test('asking only for cruisetours is a real constraint', () => {
  assert.equal(hasNoConstraints({ tripType: 'cruisetour' }), false);
});

test('describeFilter names the trip type', () => {
  assert.equal(describeFilter({ tripType: 'cruisetour', destination: 'alaska' }), 'cruisetours and Alaska');
  assert.equal(describeFilter({ tripType: 'cruise' }), 'cruises only');
});
```

Create `test/brain.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchema, buildSystemPrompt } from '../brain.js';

const values = {
  line: ['Holland America'], ship: ['Westerdam'], destination: ['alaska'],
  departurePort: ['Vancouver, B.C., CA'], cabin: ['interior'], nights: [7],
  tripType: ['cruise', 'cruisetour'],
};

test('the model can only choose a tripType that exists in the data', () => {
  const schema = buildSchema(values);
  assert.deepEqual(schema.properties.tripType, {
    anyOf: [{ type: 'string', enum: ['cruise', 'cruisetour'] }, { type: 'null' }],
  });
  assert.ok(schema.required.includes('tripType'));
});

test('the prompt says what a cruisetour is called', () => {
  const prompt = buildSystemPrompt({ from: '2027-04-24', to: '2027-09-30' });
  assert.match(prompt, /cruisetour/);
  assert.match(prompt, /Denali/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/search.test.js test/brain.test.js`
Expected: FAIL — `tripType` is ignored by the filter, absent from `CONSTRAINTS`, `describeFilter` and the schema.

- [ ] **Step 3: Implement**

In `search.js`, `searchSailings`, add after the `cabin` line:

```js
    // A sailing scraped before tripType existed is a plain cruise.
    if (filter.tripType && (s.tripType ?? 'cruise') !== filter.tripType) return false;
```

Add `'tripType'` to `CONSTRAINTS`:

```js
const CONSTRAINTS = [
  'line', 'ship', 'destination', 'departurePort', 'cabin', 'tripType',
  'nights', 'minNights', 'maxNights', 'minPrice', 'maxPrice', 'dateFrom', 'dateTo',
];
```

In `describeFilter`, add before the `cabin` line:

```js
  if (filter.tripType === 'cruisetour') parts.push('cruisetours');
  if (filter.tripType === 'cruise') parts.push('cruises only');
```

In `brain.js`, `buildSchema`, add after `cabin`:

```js
    tripType: oneOf(values.tripType ?? []),
```

In `buildSystemPrompt`, add to the Vocabulary list after the `departurePort` line:

```text
- "cruisetour", "land tour", "Denali", "Yukon" mean tripType "cruisetour" — a
  cruise plus land days, sold as one package. "cruise only", "no land tour" mean
  tripType "cruise". Otherwise tripType is null: show both.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add search.js brain.js test/search.test.js test/brain.test.js
git commit -m "Let search and the model filter on cruisetours"
```

---

### Task 5: Label cruisetours on the page

**Files:**
- Modify: `public/index.html` (styles, `buildFacets`, `applyFacets`, `render`)

**Interfaces:**
- Consumes: `sailing.tripType`, `values.tripType` from `/api/dataset`.
- Produces: nothing other code relies on.

No unit test harness covers `public/index.html`; this task is verified in the browser at Step 3.

- [ ] **Step 1: Add the label, the facet, and the filter**

In the `<style>` block, after the `.nights` rule:

```css
  .tour {
    position: absolute; left: 12px; top: 44px; background: var(--accent); color: var(--accent-ink);
    font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 999px;
  }
```

In `buildFacets`, add to `defs` after the `cabin` entry:

```js
    ['tripType', 'Trip type', (v.tripType ?? []).map(t => [t, t === 'cruisetour' ? 'Cruisetour (with land days)' : 'Cruise'])],
```

In `applyFacets`, add after the `cabin` condition:

```js
    (!f.tripType || (s.tripType ?? 'cruise') === f.tripType) &&
```

In `render`, after the line that appends the `nights` span:

```js
    if (s.tripType === 'cruisetour') {
      thumb.append(el('span', { class: 'tour', text: 'Cruisetour · includes land days' }));
    }
```

- [ ] **Step 2: Run the unit tests**

Run: `npm test`
Expected: all pass (nothing here is covered, but nothing may break).

- [ ] **Step 3: Check it in the browser — Peter does this**

Restart the server (`Ctrl-C`, then `npm run serve`) and open http://localhost:3030. The data does not contain Holland America until Task 6, so for now check only:

- The **Trip type** dropdown appears and lists **Cruise** (cruisetours appear after Task 6).
- Choosing **Cruise** still shows every sailing.

Then resize the window to about **800×600** and check the cards and facets still lay out.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Label cruisetour cards and add a trip type filter"
```

---

### Task 6: Full scrape, live verification, and the record

**Files:**
- Modify: `CLAUDE.md`
- Writes (untracked): `data/sailings.json`

**Interfaces:**
- Consumes: everything above.
- Produces: the dataset with Holland America in it.

- [ ] **Step 1: Full scrape — Peter runs it**

```bash
node scrape.js; echo "exit: $?"
```

Expected: about 23 Holland America page requests; `holland-america: ~450 sailings`; the other three lines as before; `Wrote N sailings`, N ≈ 950; **exit 0** (since 2026-10-02, exit 1 means something really failed); no Holland America values in `unrecognised` other than unpriced `row` entries.

- [ ] **Step 2: Check the dataset**

```bash
node -e '
const d=require("./data/sailings.json"); const h=d.sailings.filter(s=>s.line==="Holland America");
const t={}; h.forEach(s=>t[s.tripType]=(t[s.tripType]||0)+1);
console.log("HAL",h.length,t,"currency",[...new Set(h.map(s=>s.currency))],"dest",[...new Set(h.map(s=>s.destination))]);
console.log("dates",h.map(s=>s.departureDate).sort()[0],"->",h.map(s=>s.departureDate).sort().at(-1));
console.log("alaska total",d.sailings.filter(s=>s.destination==="alaska").length);
console.log("no tripType anywhere:",d.sailings.filter(s=>!s.tripType).length);'
```

Expected: ~450 Holland America sailings, both trip types present, USD only, `alaska` only, dates from April 2027 through roughly the end of the 2027 season, Alaska total ~500, and `0` sailings without a `tripType`.

- [ ] **Step 3: Check search in the browser — Peter does this**

The server reloads the data by itself. Try:

- "Alaska in July 2027" — expected: both kinds, cruisetour cards labelled.
- "Denali land tour" — expected: only cruisetours; "Understood as" shows "cruisetours".
- "7 night Alaska cruise only" — expected: no cruisetours; "Understood as" shows "cruises only".
- The **Trip type** dropdown now lists both options.
- **Holland America cards have no image** (the API has no image field). Expected: the
  thumbnail area shows its plain background with the nights and cruisetour labels on it —
  not a broken-image icon, and not collapsed. If it looks broken, fix it in
  `public/index.html` (e.g. a neutral placeholder), check at ~800×600 too, and commit that
  fix separately before Step 4.

- [ ] **Step 4: Update `CLAUDE.md`**

- **Status:** four lines, the new counts and price ranges from Step 2, and the test count from `npm test`.
- Add a **Holland America quirks** list beside Princess's: Alaska only and the 450 cap; prices are the cheapest **refundable** fare, unlike the other lines' cheapest fare, so they read slightly high by comparison; cruisetours and `tripType`; the `cruiseId_tourId` ID; no ship descriptions; no images.
- Replace the **Holland America (adapter #4)** handover section with a short pointer to the spec, since the work it described is done.
- **To do:** empty, or whatever Peter names next.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "Record Holland America in the project status"
```
