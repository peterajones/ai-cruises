# Cruise Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `node scrape.js`, which collects cruise sailings from Princess and Royal Caribbean and writes `data/sailings.json` — the dataset the natural-language search reads.

**Architecture:** Each site gets an adapter that knows only that site and returns site-shaped rows. Adapters split `fetch*` (needs a browser) from `parse*` (pure string → objects) so the fiddly half is testable against committed fixtures with no network. A shared `normalize.js` canonicalizes rows into one `Sailing` shape, `values.js` derives the enumeration the search model's prompt needs, and `persist.js` writes atomically.

**Tech Stack:** Node 22 (ESM), Puppeteer, `node --test`. No other dependencies.

## Global Constraints

- Node 22+. `package.json` sets `"type": "module"`. All files use ESM `import`/`export`.
- **Exactly one runtime dependency: `puppeteer`.** No other npm packages — no test framework, no HTML parser, no date library. If a task seems to need one, it is the wrong approach.
- Tests are `node --test`, run via `npm test`. The script must use the glob form
  `node --test 'test/*.test.js'` — passing a bare directory fails on Node 22.14.
- **No model calls anywhere in this codebase.** The scraper contains no AI.
- Canonical values are lowercase kebab-case: `caribbean-east`, `oceanview`, `panama-canal`.
- Dates are ISO 8601 `YYYY-MM-DD` strings. Never `Date` objects in output.
- Politeness: one browser, sequential page loads, minimum 1500 ms between loads, desktop Chrome user agent, no concurrency.
- `data/sailings.json` is only ever written via temp-file-plus-rename.
- Commit after every task.

---

### Task 1: Canonicalizing raw rows into Sailings

**Files:**
- Create: `package.json`
- Create: `normalize.js`
- Test: `test/normalize.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `canonicalDestination(raw: string) => string | null`
  - `canonicalCabin(raw: string) => string | null`
  - `toIsoDate(raw: string) => string | null`
  - `normalizeAll(rawRows: RawSailing[], opts: { source: string, line: string }) => { sailings: Sailing[], unrecognised: Miss[] }`
  - `RawSailing` = `{ externalId, url, ship, departurePort, destination, departureDate, nights, cabin, price, currency }` — every field a string or number exactly as the site gave it
  - `Sailing` = `{ id, source, url, line, ship, departurePort, destination, departureDate, nights, cabin, price, currency }`
  - `Miss` = `{ field: string, raw: string, count: number }`

**Drop rule (important, and later tasks depend on it):** a row missing any *required* field — `ship`, `departureDate`, `nights`, `price` — is dropped and recorded as a miss with `field: 'row'`. A row whose `destination` or `cabin` fails to canonicalize is **kept** with that field `null`, and the raw value recorded. Losing a sailing because one label was unfamiliar would be worse than storing it unlabelled.

- [ ] **Step 1: Create the project scaffold**

```bash
cd ~/Desktop/ai-cruises
npm init -y
npm pkg set type=module
npm pkg set private=true
npm pkg set engines.node=">=22"
npm pkg set scripts.test="node --test 'test/*.test.js'"   # a bare dir arg fails on Node 22.14
npm pkg set scripts.scrape="node scrape.js"
npm pkg delete main
mkdir -p test/fixtures sites tools data
```

- [ ] **Step 2: Write the failing test**

Create `test/normalize.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDestination, canonicalCabin, toIsoDate, normalizeAll } from '../normalize.js';

test('every spelling of Eastern Caribbean canonicalizes the same way', () => {
  for (const raw of ['Eastern Caribbean', 'Caribbean - Eastern', 'E. Caribbean', 'CARIBBEAN EAST']) {
    assert.equal(canonicalDestination(raw), 'caribbean-east', `failed on: ${raw}`);
  }
});

test('cabin synonyms canonicalize', () => {
  assert.equal(canonicalCabin('Inside'), 'interior');
  assert.equal(canonicalCabin('Interior Stateroom'), 'interior');
  assert.equal(canonicalCabin('Ocean View'), 'oceanview');
  assert.equal(canonicalCabin('Outside'), 'oceanview');
  assert.equal(canonicalCabin('Verandah'), 'balcony');
  assert.equal(canonicalCabin('Mini-Suite'), 'suite');
});

test('unknown values return null rather than guessing', () => {
  assert.equal(canonicalDestination('Panama Canal - Partial Transit'), null);
  assert.equal(canonicalCabin('Igloo'), null);
});

test('dates in any of the observed formats become ISO', () => {
  assert.equal(toIsoDate('2027-01-16'), '2027-01-16');
  assert.equal(toIsoDate('Jan 16, 2027'), '2027-01-16');
  assert.equal(toIsoDate('January 16, 2027'), '2027-01-16');
  assert.equal(toIsoDate('01/16/2027'), '2027-01-16');
  assert.equal(toIsoDate('sometime in spring'), null);
});

const goodRow = {
  externalId: '12345',
  url: 'https://www.princess.com/cruise/12345',
  ship: 'Sky Princess',
  departurePort: 'Fort Lauderdale',
  destination: 'Caribbean - Eastern',
  departureDate: 'Jan 16, 2027',
  nights: '7',
  cabin: 'Verandah',
  price: '$1,299',
  currency: 'USD',
};

test('a good row becomes a fully canonical Sailing', () => {
  const { sailings, unrecognised } = normalizeAll([goodRow], { source: 'princess', line: 'Princess' });
  assert.equal(unrecognised.length, 0);
  assert.deepEqual(sailings[0], {
    id: 'princess:12345',
    source: 'princess',
    url: 'https://www.princess.com/cruise/12345',
    line: 'Princess',
    ship: 'Sky Princess',
    departurePort: 'Fort Lauderdale',
    destination: 'caribbean-east',
    departureDate: '2027-01-16',
    nights: 7,
    cabin: 'balcony',
    price: 1299,
    currency: 'USD',
  });
});

test('an unmappable destination keeps the sailing and records the miss', () => {
  const row = { ...goodRow, destination: 'Panama Canal - Partial Transit' };
  const { sailings, unrecognised } = normalizeAll([row], { source: 'princess', line: 'Princess' });
  assert.equal(sailings.length, 1);
  assert.equal(sailings[0].destination, null);
  assert.deepEqual(unrecognised, [
    { field: 'destination', raw: 'Panama Canal - Partial Transit', count: 1 },
  ]);
});

test('misses are counted, not repeated', () => {
  const row = { ...goodRow, destination: 'Fjords of Nowhere' };
  const { unrecognised } = normalizeAll([row, { ...row, externalId: '2' }, { ...row, externalId: '3' }],
    { source: 'princess', line: 'Princess' });
  assert.deepEqual(unrecognised, [{ field: 'destination', raw: 'Fjords of Nowhere', count: 3 }]);
});

test('a row missing a required field is dropped and recorded', () => {
  const { sailings, unrecognised } = normalizeAll([{ ...goodRow, price: null }],
    { source: 'princess', line: 'Princess' });
  assert.equal(sailings.length, 0);
  assert.equal(unrecognised[0].field, 'row');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../normalize.js'`

- [ ] **Step 4: Write the implementation**

Create `normalize.js`:

```js
/**
 * Canonicalizing. No AI here on purpose — every rule below is one you can state,
 * so it is written as a rule you can read and correct.
 */

/** Canonical destination -> the spellings sites actually use. */
const DESTINATIONS = {
  'caribbean-east': ['eastern caribbean', 'caribbean eastern', 'e caribbean', 'caribbean east'],
  'caribbean-west': ['western caribbean', 'caribbean western', 'w caribbean', 'caribbean west'],
  'caribbean-south': ['southern caribbean', 'caribbean southern', 's caribbean', 'caribbean south'],
  'caribbean': ['caribbean'],
  'bahamas': ['bahamas', 'bahamas florida'],
  'bermuda': ['bermuda'],
  'alaska': ['alaska', 'alaska inside passage', 'inside passage', 'alaska gulf'],
  'mexico': ['mexico', 'mexican riviera', 'baja mexico'],
  'hawaii': ['hawaii', 'hawaiian islands'],
  'mediterranean-west': ['western mediterranean', 'mediterranean western', 'w mediterranean'],
  'mediterranean-east': ['eastern mediterranean', 'mediterranean eastern', 'e mediterranean'],
  'mediterranean': ['mediterranean', 'med'],
  'northern-europe': ['northern europe', 'norway', 'norwegian fjords', 'baltic', 'scandinavia'],
  'british-isles': ['british isles', 'ireland britain'],
  'transatlantic': ['transatlantic', 'trans atlantic', 'repositioning transatlantic'],
  'panama-canal': ['panama canal', 'panama canal full transit'],
  'south-america': ['south america', 'south america antarctica'],
  'asia': ['asia', 'southeast asia', 'japan', 'far east'],
  'australia-nz': ['australia new zealand', 'australia', 'new zealand', 'south pacific'],
  'antarctica': ['antarctica'],
  'canada-new-england': ['canada new england', 'new england canada', 'canada'],
  'world': ['world cruise', 'grand voyage', 'world'],
};

/** Canonical cabin -> the names sites actually use. */
const CABINS = {
  interior: ['interior', 'inside', 'interior stateroom', 'inside stateroom', 'inside cabin'],
  oceanview: ['oceanview', 'ocean view', 'outside', 'outside stateroom', 'sea view', 'obstructed oceanview'],
  balcony: ['balcony', 'verandah', 'veranda', 'balcony stateroom', 'deluxe balcony'],
  suite: ['suite', 'mini suite', 'minisuite', 'junior suite', 'owners suite', 'penthouse'],
};

/** Fold punctuation and case away so 'Caribbean - Eastern' and 'E. Caribbean' compare. */
function key(raw) {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildLookup(groups) {
  const lookup = new Map();
  for (const [canonical, aliases] of Object.entries(groups)) {
    lookup.set(key(canonical), canonical);
    for (const alias of aliases) lookup.set(key(alias), canonical);
  }
  return lookup;
}

const DESTINATION_LOOKUP = buildLookup(DESTINATIONS);
const CABIN_LOOKUP = buildLookup(CABINS);

export function canonicalDestination(raw) {
  return DESTINATION_LOOKUP.get(key(raw)) ?? null;
}

export function canonicalCabin(raw) {
  return CABIN_LOOKUP.get(key(raw)) ?? null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function toIsoDate(raw) {
  const text = String(raw ?? '').trim();

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${pad(slash[1])}-${pad(slash[2])}`;

  const named = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    if (month >= 0) return `${named[3]}-${pad(month + 1)}-${pad(named[2])}`;
  }

  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** '$1,299' and '1299.00' both become 1299. Returns null if there is no number. */
function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/[^0-9.]/g, '');
  if (digits === '') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

const REQUIRED = ['ship', 'departureDate', 'nights', 'price'];

/**
 * @param {object[]} rawRows - site-shaped rows straight from an adapter
 * @param {{source: string, line: string}} opts
 * @returns {{sailings: object[], unrecognised: {field: string, raw: string, count: number}[]}}
 */
export function normalizeAll(rawRows, { source, line }) {
  const sailings = [];
  const misses = new Map();

  // Key on a JSON pair rather than a delimited string: raw values contain spaces,
  // hyphens and commas, so any separator character you pick will eventually appear
  // inside one and split it in the wrong place.
  const miss = (field, raw) => {
    const k = JSON.stringify([field, raw]);
    misses.set(k, (misses.get(k) ?? 0) + 1);
  };

  for (const row of rawRows) {
    const sailing = {
      id: `${source}:${row.externalId}`,
      source,
      url: row.url ?? null,
      line: row.line ?? line,
      ship: row.ship ? String(row.ship).trim() : null,
      departurePort: row.departurePort ? String(row.departurePort).trim() : null,
      destination: null,
      departureDate: toIsoDate(row.departureDate),
      nights: toNumber(row.nights),
      cabin: null,
      price: toNumber(row.price),
      currency: row.currency ?? 'USD',
    };

    if (row.destination) {
      sailing.destination = canonicalDestination(row.destination);
      if (sailing.destination === null) miss('destination', String(row.destination));
    }

    if (row.cabin) {
      sailing.cabin = canonicalCabin(row.cabin);
      if (sailing.cabin === null) miss('cabin', String(row.cabin));
    }

    const missingField = REQUIRED.find((f) => sailing[f] === null || sailing[f] === '');
    if (missingField) {
      miss('row', `${sailing.id} missing ${missingField}`);
      continue;
    }

    sailings.push(sailing);
  }

  const unrecognised = [...misses.entries()].map(([k, count]) => {
    const [field, raw] = JSON.parse(k);
    return { field, raw, count };
  });

  return { sailings, unrecognised };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add package.json normalize.js test/normalize.test.js
git commit -m "Add canonicalizing of raw site rows into Sailings"
```

---

### Task 2: Deriving the value enumeration

**Files:**
- Create: `values.js`
- Test: `test/values.test.js`

**Interfaces:**
- Consumes: `Sailing` from Task 1
- Produces: `deriveValues(sailings: Sailing[]) => { line: string[], destination: string[], cabin: string[], departurePort: string[], nights: number[] }`

This is the file the whole search layer's reliability rests on. `brain.js` will enumerate these lists in its prompt; if they drift from the data, the model emits values matching nothing and searches fail silently. Deriving them makes drift impossible — which is why this is never hand-written.

- [ ] **Step 1: Write the failing test**

Create `test/values.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveValues } from '../values.js';

const sailings = [
  { line: 'Princess', ship: 'Sky Princess', departurePort: 'Fort Lauderdale',
    destination: 'caribbean-east', cabin: 'balcony', nights: 7 },
  { line: 'Princess', ship: 'Sky Princess', departurePort: 'Seattle',
    destination: 'alaska', cabin: 'interior', nights: 14 },
  { line: 'Royal Caribbean', ship: 'Icon of the Seas', departurePort: 'Miami',
    destination: 'caribbean-east', cabin: 'suite', nights: 7 },
];

test('each enumeration is unique and sorted', () => {
  const values = deriveValues(sailings);
  assert.deepEqual(values.line, ['Princess', 'Royal Caribbean']);
  assert.deepEqual(values.destination, ['alaska', 'caribbean-east']);
  assert.deepEqual(values.cabin, ['balcony', 'interior', 'suite']);
  assert.deepEqual(values.departurePort, ['Fort Lauderdale', 'Miami', 'Seattle']);
});

test('nights sorts numerically, not as strings', () => {
  const values = deriveValues([...sailings, { ...sailings[0], nights: 3 }, { ...sailings[0], nights: 21 }]);
  assert.deepEqual(values.nights, [3, 7, 14, 21]);
});

test('nulls never reach the enumeration', () => {
  const values = deriveValues([...sailings, { ...sailings[0], destination: null, cabin: null }]);
  assert.deepEqual(values.destination, ['alaska', 'caribbean-east']);
  assert.deepEqual(values.cabin, ['balcony', 'interior', 'suite']);
});

test('no sailings gives empty lists, not undefined', () => {
  assert.deepEqual(deriveValues([]), {
    line: [], destination: [], cabin: [], departurePort: [], nights: [],
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../values.js'`

- [ ] **Step 3: Write the implementation**

Create `values.js`:

```js
/**
 * Derives the enumeration brain.js puts in its prompt.
 *
 * Never hand-write this list. If it drifts from what is actually in
 * data/sailings.json, the model confidently emits a value that matches nothing
 * and the search returns empty with no error anywhere.
 */

function uniqueSortedStrings(values) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ''))].sort();
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter((v) => typeof v === 'number' && Number.isFinite(v)))]
    .sort((a, b) => a - b);
}

/**
 * @param {object[]} sailings
 * @returns {{line: string[], destination: string[], cabin: string[],
 *            departurePort: string[], nights: number[]}}
 */
export function deriveValues(sailings) {
  return {
    line: uniqueSortedStrings(sailings.map((s) => s.line)),
    destination: uniqueSortedStrings(sailings.map((s) => s.destination)),
    cabin: uniqueSortedStrings(sailings.map((s) => s.cabin)),
    departurePort: uniqueSortedStrings(sailings.map((s) => s.departurePort)),
    nights: uniqueSortedNumbers(sailings.map((s) => s.nights)),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 12 tests total

- [ ] **Step 5: Commit**

```bash
git add values.js test/values.test.js
git commit -m "Derive the search value enumeration from scraped sailings"
```

---

### Task 3: Bot-wall detection and polite browsing

**Files:**
- Create: `errors.js`
- Create: `browser.js`
- Test: `test/browser.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class BotWallError extends Error` (property `.reason`)
  - `class EmptyResultError extends Error`
  - `USER_AGENT: string`
  - `detectBotWall(body: string) => string | null` — pure; returns a reason or null
  - `politeDelay(ms?: number) => Promise<void>` — default 1500
  - `launch() => Promise<Browser>`
  - `newPage(browser) => Promise<Page>`

`detectBotWall` is pure and gets real tests. `launch`/`newPage` need Chrome and are exercised only by the smoke run in Task 11.

The Incapsula fixture below is a real response captured from `cruise.com` on 2026-08-03 — that site is not a target, but its challenge page is exactly the shape this must catch.

- [ ] **Step 1: Write the failing test**

Create `test/browser.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBotWall, USER_AGENT } from '../browser.js';

const INCAPSULA = `<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">
<script type="text/javascript" src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e"></script></head>
<body><iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=31">
Request unsuccessful. Incapsula incident ID: 1848000740416814348</iframe></body></html>`;

const CLOUDFLARE = `<html><head><title>Just a moment...</title></head>
<body><div class="cf-browser-verification">Checking your browser</div></body></html>`;

const REAL_PAGE = `<html><head><title>Find a Cruise</title></head><body>
<div class="results">${'<div class="sailing">7 Night Caribbean</div>'.repeat(60)}</div></body></html>`;

test('catches an Incapsula challenge', () => {
  assert.match(detectBotWall(INCAPSULA), /incapsula/i);
});

test('catches a Cloudflare interstitial', () => {
  assert.match(detectBotWall(CLOUDFLARE), /cloudflare|just a moment/i);
});

test('catches a suspiciously tiny body', () => {
  assert.match(detectBotWall('<html><body>Access Denied</body></html>'), /denied|too small/i);
});

test('a real page is not a bot wall', () => {
  assert.equal(detectBotWall(REAL_PAGE), null);
});

test('the user agent is a plausible desktop Chrome', () => {
  assert.match(USER_AGENT, /^Mozilla\/5\.0 \(Macintosh.*Chrome\/\d+/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../browser.js'`

- [ ] **Step 3: Write the implementation**

Create `errors.js`:

```js
/** The page was a challenge or block, not content. Different fix from a parse failure. */
export class BotWallError extends Error {
  constructor(reason, url) {
    super(`Bot wall at ${url}: ${reason}`);
    this.name = 'BotWallError';
    this.reason = reason;
    this.url = url;
  }
}

/** Parsed zero rows where rows were expected. Never treat this as "no results". */
export class EmptyResultError extends Error {
  constructor(context) {
    super(`Parsed 0 rows from ${context}. Selectors probably broke, or this was a bot wall.`);
    this.name = 'EmptyResultError';
    this.context = context;
  }
}
```

Create `browser.js`:

```js
import puppeteer from 'puppeteer';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/** Minimum gap between page loads. Nothing here needs to be fast; an IP block costs a day. */
export const POLITE_DELAY_MS = 1500;

const WALL_SIGNATURES = [
  [/_Incapsula_Resource|Incapsula incident/i, 'Incapsula challenge page'],
  [/cf-browser-verification|Just a moment\.\.\./i, 'Cloudflare interstitial'],
  [/px-captcha|PerimeterX/i, 'PerimeterX captcha'],
  [/Access Denied|You have been blocked/i, 'access denied'],
];

/**
 * Pure. Returns a human-readable reason, or null if the body looks like content.
 * @param {string} body
 * @returns {string|null}
 */
export function detectBotWall(body) {
  const text = String(body ?? '');
  for (const [pattern, reason] of WALL_SIGNATURES) {
    if (pattern.test(text)) return reason;
  }
  // A real listing page is never a few hundred bytes. A stub this small is a block.
  if (text.trim().length < 1000) return `response too small (${text.trim().length} bytes)`;
  return null;
}

export function politeDelay(ms = POLITE_DELAY_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launch() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
}

export async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1440, height: 900 });
  return page;
}
```

- [ ] **Step 4: Install Puppeteer**

```bash
npm install puppeteer
```

Expected: downloads a bundled Chromium; takes a minute or two on first install.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 17 tests total

- [ ] **Step 6: Commit**

```bash
git add errors.js browser.js test/browser.test.js package.json package-lock.json
git commit -m "Add bot-wall detection and polite browser helpers"
```

---

### Task 4: Atomic persistence and the ship cache

**Files:**
- Create: `persist.js`
- Test: `test/persist.test.js`

**Interfaces:**
- Consumes: `EmptyResultError` from Task 3
- Produces:
  - `assertNonEmpty(rows: any[], context: string) => void` — throws `EmptyResultError`
  - `loadExisting(dataDir: string) => Promise<object|null>`
  - `mergeShips(existing: object, fresh: object, opts: { refresh: boolean }) => object`
  - `writeResult(dataDir: string, result: object) => Promise<string>` — returns the path written

- [ ] **Step 1: Write the failing test**

Create `test/persist.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../persist.js'`

- [ ] **Step 3: Write the implementation**

Create `persist.js`:

```js
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EmptyResultError } from './errors.js';

/**
 * Zero rows is a failure, not an empty ocean. Without this, a changed selector
 * silently overwrites good data with an empty array.
 */
export function assertNonEmpty(rows, context) {
  if (!Array.isArray(rows) || rows.length === 0) throw new EmptyResultError(context);
}

export async function loadExisting(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, 'sailings.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * A ship's blurb changes roughly never, so cached descriptions win unless
 * --refresh-ships was passed.
 */
export function mergeShips(existing = {}, fresh = {}, { refresh }) {
  return refresh ? { ...existing, ...fresh } : { ...fresh, ...existing };
}

/**
 * Temp file plus rename, so a crash mid-write never leaves half a file where a
 * good one used to be. Also drops a dated copy in runs/ for later price history.
 * @returns {Promise<string>} path of the file written
 */
export async function writeResult(dataDir, result) {
  await mkdir(join(dataDir, 'runs'), { recursive: true });

  const json = `${JSON.stringify(result, null, 2)}\n`;
  const target = join(dataDir, 'sailings.json');
  const temp = `${target}.tmp`;

  await writeFile(temp, json, 'utf8');
  await rename(temp, target);

  const stamp = result.scrapedAt.replace(/:/g, '-');
  await writeFile(join(dataDir, 'runs', `${stamp}.json`), json, 'utf8');

  return target;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 24 tests total

- [ ] **Step 5: Commit**

```bash
git add persist.js test/persist.test.js
git commit -m "Add atomic result writing, run snapshots and the ship cache"
```

---

### Task 5: Fixture capture tool, and capturing Princess

**Files:**
- Create: `tools/capture-fixture.js`
- Create: `test/fixtures/princess-listing.json` (captured, committed)
- Create: `test/fixtures/princess-ship.html` (captured, committed)
- Create: `test/fixtures/NOTES.md` (observations, committed)

**Interfaces:**
- Consumes: `launch`, `newPage`, `politeDelay`, `detectBotWall` from Task 3
- Produces: committed fixtures for Task 6, and a reusable tool for Task 8

This task is **discovery**, not TDD — its deliverable is captured evidence about a site nobody has inspected yet. It has no unit test; it is verified by the fixtures existing and containing sailing data.

The tool is deliberately URL-driven rather than adapter-driven, so it works before any adapter exists.

- [ ] **Step 1: Write the capture tool**

Create `tools/capture-fixture.js`:

```js
/**
 * Dev tool. Opens a URL, records the JSON responses the page fetches, and saves
 * one of them as a test fixture.
 *
 *   node tools/capture-fixture.js --url <url> --list
 *   node tools/capture-fixture.js --url <url> --match search --out test/fixtures/x.json
 *   node tools/capture-fixture.js --url <url> --html --out test/fixtures/x.html
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { launch, newPage, politeDelay } from '../browser.js';
import { detectBotWall } from '../browser.js';

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' },
    match: { type: 'string', default: '' },
    out: { type: 'string' },
    list: { type: 'boolean', default: false },
    html: { type: 'boolean', default: false },
    wait: { type: 'string', default: '8000' },
  },
});

if (!opts.url) {
  console.error('--url is required');
  process.exit(2);
}

const browser = await launch();
const page = await newPage(browser);
const captured = [];

page.on('response', async (response) => {
  const url = response.url();
  const type = response.headers()['content-type'] ?? '';
  if (!type.includes('json')) return;
  if (opts.match && !url.includes(opts.match)) return;
  try {
    const body = await response.text();
    captured.push({ url, bytes: body.length, body });
  } catch {
    // Response body already gone (redirect, or the page navigated away). Skip it.
  }
});

await page.goto(opts.url, { waitUntil: 'networkidle2', timeout: 60_000 });
await politeDelay(Number(opts.wait));

const html = await page.content();
const wall = detectBotWall(html);
if (wall) console.error(`WARNING: page looks like a bot wall (${wall})`);

captured.sort((a, b) => b.bytes - a.bytes);

if (opts.list || !opts.out) {
  console.log(`\n${captured.length} JSON responses, largest first:\n`);
  for (const c of captured.slice(0, 25)) {
    console.log(`${String(c.bytes).padStart(9)}  ${c.url.slice(0, 140)}`);
  }
  console.log('\nRe-run with --match <substring> --out <path> to save one.');
} else if (opts.html) {
  await writeFile(opts.out, html, 'utf8');
  console.log(`Saved ${html.length} bytes of HTML to ${opts.out}`);
} else if (captured.length === 0) {
  console.error('No JSON responses matched. Try --list, or --html if the page is server-rendered.');
  process.exitCode = 1;
} else {
  await writeFile(opts.out, captured[0].body, 'utf8');
  console.log(`Saved ${captured[0].bytes} bytes from ${captured[0].url} to ${opts.out}`);
}

await browser.close();
```

- [ ] **Step 2: Discover which response carries Princess sailings**

```bash
node tools/capture-fixture.js --url "https://www.princess.com/en-us/cruise-search" --list
```

Expected: a list of JSON response URLs with sizes. The sailings payload is normally the largest and its URL contains something like `search`, `sailings`, `voyages` or `results`.

If the list is empty, the page is server-rendered — fall back to `--html` and parse the DOM in Task 6 instead.

- [ ] **Step 3: Save the Princess listing fixture**

```bash
node tools/capture-fixture.js \
  --url "https://www.princess.com/en-us/cruise-search" \
  --match <the substring you identified in Step 2> \
  --out test/fixtures/princess-listing.json
```

Verify it contains sailings:

```bash
node -e "const d=require('./test/fixtures/princess-listing.json'); console.log(Object.keys(d)); console.log(JSON.stringify(d).length, 'bytes')"
```

- [ ] **Step 4: Save a Princess ship page fixture**

Pick any ship name that appears in the listing fixture, open its page on princess.com, and save the HTML:

```bash
node tools/capture-fixture.js \
  --url "https://www.princess.com/en-us/ships/<ship-slug>" \
  --html --out test/fixtures/princess-ship.html
```

- [ ] **Step 5: Record what you found**

Create `test/fixtures/NOTES.md` documenting, for Princess:

- the listing URL used, and the response URL substring that carries sailings
- the JSON path to the array of sailings (e.g. `data.results.sailings`)
- the field names on one sailing object that correspond to each `RawSailing` field: `externalId`, `url`, `ship`, `departurePort`, `destination`, `departureDate`, `nights`, `cabin`, `price`
- how many sailings the fixture contains
- the CSS selector on the ship page that holds the description prose

- [ ] **Step 6: Commit**

```bash
git add tools/capture-fixture.js test/fixtures/
git commit -m "Add fixture capture tool and capture Princess fixtures"
```

---

### Task 6: Princess parsing

**Files:**
- Create: `sites/princess.js` (parse functions only — `fetch*` comes in Task 7)
- Create: `test/fixtures/princess-first-row.json` (golden, hand-written from the fixture)
- Test: `test/princess.test.js`

**Interfaces:**
- Consumes: `test/fixtures/princess-listing.json` and `NOTES.md` from Task 5
- Produces:
  - `name = 'princess'`, `line = 'Princess'`
  - `parseListing(payload: string) => RawSailing[]` — pure
  - `parseShip(html: string) => { line: string, description: string }` — pure

`RawSailing` field names must match Task 1's list exactly, because `normalizeAll` reads them by name.

- [ ] **Step 1: Write the golden first row by hand**

Open `test/fixtures/princess-listing.json`, find the first sailing, and write what `parseListing` should produce for it into `test/fixtures/princess-first-row.json`. Use the real values from the fixture — this is the file that makes the test meaningful rather than circular:

```json
{
  "externalId": "<the sailing's id from the fixture>",
  "url": "<its detail URL>",
  "ship": "<ship name>",
  "departurePort": "<departure port>",
  "destination": "<destination label, raw>",
  "departureDate": "<date, raw>",
  "nights": "<nights, raw>",
  "cabin": "<cheapest cabin tier label, raw>",
  "price": "<cheapest price, raw>",
  "currency": "USD"
}
```

- [ ] **Step 2: Write the failing test**

Create `test/princess.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, parseShip, name, line } from '../sites/princess.js';
import { normalizeAll } from '../normalize.js';

const payload = await readFile(new URL('./fixtures/princess-listing.json', import.meta.url), 'utf8');
const shipHtml = await readFile(new URL('./fixtures/princess-ship.html', import.meta.url), 'utf8');
const golden = JSON.parse(
  await readFile(new URL('./fixtures/princess-first-row.json', import.meta.url), 'utf8'),
);

test('the adapter identifies itself', () => {
  assert.equal(name, 'princess');
  assert.equal(line, 'Princess');
});

test('parses a non-empty list of sailings from the real fixture', () => {
  const rows = parseListing(payload);
  assert.ok(rows.length > 0, 'expected at least one sailing');
});

test('the first row matches the hand-written golden row', () => {
  assert.deepEqual(parseListing(payload)[0], golden);
});

test('every row has the fields normalizeAll requires', () => {
  for (const row of parseListing(payload)) {
    assert.ok(row.externalId, `missing externalId: ${JSON.stringify(row)}`);
    assert.ok(row.ship, `missing ship: ${JSON.stringify(row)}`);
    assert.ok(row.departureDate, `missing departureDate: ${JSON.stringify(row)}`);
    assert.ok(row.nights, `missing nights: ${JSON.stringify(row)}`);
    assert.ok(row.price, `missing price: ${JSON.stringify(row)}`);
  }
});

test('external IDs are unique', () => {
  const ids = parseListing(payload).map((r) => r.externalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate externalId values');
});

test('the fixture survives normalizeAll with no dropped rows', () => {
  const rows = parseListing(payload);
  const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
  assert.equal(sailings.length, rows.length,
    `dropped rows: ${JSON.stringify(unrecognised.filter((u) => u.field === 'row'), null, 2)}`);
});

test('parses a description out of the ship page', () => {
  const ship = parseShip(shipHtml);
  assert.equal(ship.line, 'Princess');
  assert.ok(ship.description.length > 80, `description too short: "${ship.description}"`);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../sites/princess.js'`

- [ ] **Step 4: Implement the parse functions**

Create `sites/princess.js`. Use the JSON path and field names recorded in `NOTES.md`. The shape below is the contract; the property lookups inside come from your fixture:

```js
/**
 * Princess adapter. Knows about princess.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 */

export const name = 'princess';
export const line = 'Princess';

/**
 * @param {string} payload - raw JSON text captured from the search response
 * @returns {object[]} RawSailing rows
 */
export function parseListing(payload) {
  const data = JSON.parse(payload);

  // Path recorded in test/fixtures/NOTES.md during Task 5.
  const rows = /* navigate `data` to the sailings array */ [];

  return rows.map((row) => ({
    externalId: String(/* id field */ ''),
    url: /* absolute detail URL */ '',
    ship: /* ship name */ '',
    departurePort: /* departure port */ '',
    destination: /* raw destination label */ '',
    departureDate: /* raw departure date */ '',
    nights: /* nights */ '',
    cabin: /* cheapest cabin tier label */ '',
    price: /* cheapest price */ '',
    currency: 'USD',
  }));
}

/**
 * @param {string} html - a ship page
 * @returns {{line: string, description: string}}
 */
export function parseShip(html) {
  // No HTML parser dependency: pull the description block out with a regex over the
  // container recorded in NOTES.md, then strip tags and collapse whitespace.
  const block = html.match(/* container pattern from NOTES.md */);
  const description = String(block?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { line, description };
}
```

The comment markers above are the only places you write site-specific code. Everything else is fixed by the contract.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS. If "the fixture survives normalizeAll" fails, the failure message lists exactly which rows were dropped and why — usually a date format `toIsoDate` does not yet handle, or a destination label missing from `normalize.js`. Add the alias or the format, and re-run.

- [ ] **Step 6: Commit**

```bash
git add sites/princess.js test/princess.test.js test/fixtures/princess-first-row.json
git commit -m "Parse Princess sailings and ship descriptions"
```

---

### Task 7: Princess fetching

**Files:**
- Modify: `sites/princess.js` (add `fetchListingPages` and `fetchShipPage`)

**Interfaces:**
- Consumes: `politeDelay`, `detectBotWall` from Task 3; `BotWallError` from Task 3
- Produces:
  - `fetchListingPages(page, { limit }) => Promise<string[]>` — array of raw JSON payload strings
  - `fetchShipPage(page, ship) => Promise<string>` — raw HTML
  - `shipUrl(ship: string) => string`

No unit test: this needs the live site, and a test for it would be testing Princess's uptime. It is verified by the smoke run in the final step.

- [ ] **Step 1: Add the fetch functions**

Append to `sites/princess.js`:

```js
import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

const SEARCH_URL = 'https://www.princess.com/en-us/cruise-search';

/** Response URL substring that carries sailings — recorded in NOTES.md, Task 5. */
const RESULTS_MATCH = /* the substring you identified */ '';

export function shipUrl(ship) {
  const slug = ship.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.princess.com/en-us/ships/${slug}`;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{limit: number}} options
 * @returns {Promise<string[]>} raw JSON payloads, in the order received
 */
export async function fetchListingPages(page, { limit }) {
  const payloads = [];

  page.on('response', async (response) => {
    if (!response.url().includes(RESULTS_MATCH)) return;
    if (!(response.headers()['content-type'] ?? '').includes('json')) return;
    try {
      payloads.push(await response.text());
    } catch {
      // Body no longer available; the next page load will produce another.
    }
  });

  await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
  await politeDelay();

  const wall = detectBotWall(await page.content());
  if (wall) throw new BotWallError(wall, SEARCH_URL);

  // Paginate by clicking "load more" until we have enough rows or run out.
  // Selector recorded in NOTES.md; stop when it is absent.
  while (payloads.length * 20 < limit) {
    const more = await page.$(/* load-more selector from NOTES.md */);
    if (!more) break;
    await more.click();
    await politeDelay();
  }

  return payloads;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} ship
 * @returns {Promise<string>} raw HTML
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

- [ ] **Step 2: Verify against the live site**

```bash
node -e "
import('./browser.js').then(async (b) => {
  const p = await import('./sites/princess.js');
  const browser = await b.launch();
  const page = await b.newPage(browser);
  const payloads = await p.fetchListingPages(page, { limit: 20 });
  const rows = payloads.flatMap(p.parseListing);
  console.log('payloads:', payloads.length, 'rows:', rows.length);
  console.log(rows[0]);
  await browser.close();
});
"
```

Expected: at least one payload and a non-zero row count, with a first row that looks like the golden fixture.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all previous tests still green.

- [ ] **Step 4: Commit**

```bash
git add sites/princess.js
git commit -m "Fetch Princess listings and ship pages"
```

---

### Task 8: Royal Caribbean capture and parsing

**Files:**
- Create: `sites/royal-caribbean.js` (parse functions only)
- Create: `test/fixtures/royal-caribbean-listing.json` (captured)
- Create: `test/fixtures/royal-caribbean-ship.html` (captured)
- Create: `test/fixtures/royal-caribbean-first-row.json` (golden)
- Modify: `test/fixtures/NOTES.md` (add a Royal Caribbean section)
- Test: `test/royal-caribbean.test.js`

**Interfaces:**
- Consumes: `tools/capture-fixture.js` from Task 5; `normalizeAll` from Task 1
- Produces: `name = 'royal-caribbean'`, `line = 'Royal Caribbean'`, `parseListing`, `parseShip` — identical signatures to Task 6

This repeats Task 5 and Task 6 against a second site. That repetition is the point: it is what proves the adapter seam holds, and it is where a multi-site design normally breaks.

- [ ] **Step 1: Discover the results response**

```bash
node tools/capture-fixture.js --url "https://www.royalcaribbean.com/cruises" --list
```

Expected: a list of JSON response URLs with sizes. Note that Akamai is in this site's stack — if the output warns about a bot wall, record that in `NOTES.md` and report it rather than trying to evade it.

- [ ] **Step 2: Save the fixtures**

```bash
node tools/capture-fixture.js --url "https://www.royalcaribbean.com/cruises" \
  --match <substring from Step 1> --out test/fixtures/royal-caribbean-listing.json

node tools/capture-fixture.js --url "https://www.royalcaribbean.com/cruise-ships/<ship-slug>" \
  --html --out test/fixtures/royal-caribbean-ship.html
```

- [ ] **Step 3: Add a Royal Caribbean section to NOTES.md**

Record the same six items Task 5 Step 5 lists, for this site.

- [ ] **Step 4: Write the golden first row**

Create `test/fixtures/royal-caribbean-first-row.json` from the first sailing in the captured fixture, using the same ten keys as `princess-first-row.json`: `externalId`, `url`, `ship`, `departurePort`, `destination`, `departureDate`, `nights`, `cabin`, `price`, `currency`.

- [ ] **Step 5: Write the failing test**

Create `test/royal-caribbean.test.js`:

```js
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

test('parses a non-empty list of sailings from the real fixture', () => {
  assert.ok(parseListing(payload).length > 0, 'expected at least one sailing');
});

test('the first row matches the hand-written golden row', () => {
  assert.deepEqual(parseListing(payload)[0], golden);
});

test('every row has the fields normalizeAll requires', () => {
  for (const row of parseListing(payload)) {
    assert.ok(row.externalId, `missing externalId: ${JSON.stringify(row)}`);
    assert.ok(row.ship, `missing ship: ${JSON.stringify(row)}`);
    assert.ok(row.departureDate, `missing departureDate: ${JSON.stringify(row)}`);
    assert.ok(row.nights, `missing nights: ${JSON.stringify(row)}`);
    assert.ok(row.price, `missing price: ${JSON.stringify(row)}`);
  }
});

test('external IDs are unique', () => {
  const ids = parseListing(payload).map((r) => r.externalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate externalId values');
});

test('the fixture survives normalizeAll with no dropped rows', () => {
  const rows = parseListing(payload);
  const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
  assert.equal(sailings.length, rows.length,
    `dropped rows: ${JSON.stringify(unrecognised.filter((u) => u.field === 'row'), null, 2)}`);
});

test('parses a description out of the ship page', () => {
  const ship = parseShip(shipHtml);
  assert.equal(ship.line, 'Royal Caribbean');
  assert.ok(ship.description.length > 80, `description too short: "${ship.description}"`);
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../sites/royal-caribbean.js'`

- [ ] **Step 7: Implement the parse functions**

Create `sites/royal-caribbean.js` with the same structure as `sites/princess.js`:

```js
/**
 * Royal Caribbean adapter. Knows about royalcaribbean.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 */

export const name = 'royal-caribbean';
export const line = 'Royal Caribbean';

/**
 * @param {string} payload - raw JSON text captured from the search response
 * @returns {object[]} RawSailing rows
 */
export function parseListing(payload) {
  const data = JSON.parse(payload);

  // Path recorded in test/fixtures/NOTES.md during Step 3.
  const rows = /* navigate `data` to the sailings array */ [];

  return rows.map((row) => ({
    externalId: String(/* id field */ ''),
    url: /* absolute detail URL */ '',
    ship: /* ship name */ '',
    departurePort: /* departure port */ '',
    destination: /* raw destination label */ '',
    departureDate: /* raw departure date */ '',
    nights: /* nights */ '',
    cabin: /* cheapest cabin tier label */ '',
    price: /* cheapest price */ '',
    currency: 'USD',
  }));
}

/**
 * @param {string} html - a ship page
 * @returns {{line: string, description: string}}
 */
export function parseShip(html) {
  const block = html.match(/* container pattern from NOTES.md */);
  const description = String(block?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { line, description };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test`
Expected: PASS. If Royal Caribbean uses destination or cabin labels `normalize.js` does not know, the `normalizeAll` test names them — add the aliases to `normalize.js` and re-run. **Adding aliases is the correct fix. Weakening the test is not.**

- [ ] **Step 9: Commit**

```bash
git add sites/royal-caribbean.js test/royal-caribbean.test.js test/fixtures/ normalize.js
git commit -m "Parse Royal Caribbean sailings and ship descriptions"
```

---

### Task 9: Royal Caribbean fetching

**Files:**
- Modify: `sites/royal-caribbean.js` (add `fetchListingPages`, `fetchShipPage`, `shipUrl`)

**Interfaces:**
- Consumes: `politeDelay`, `detectBotWall`, `BotWallError` from Task 3
- Produces: `fetchListingPages(page, { limit }) => Promise<string[]>`, `fetchShipPage(page, ship) => Promise<string>`, `shipUrl(ship) => string` — identical signatures to Task 7

- [ ] **Step 1: Add the fetch functions**

Append to `sites/royal-caribbean.js`, following the same structure as `sites/princess.js`:

```js
import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

const SEARCH_URL = 'https://www.royalcaribbean.com/cruises';

/** Response URL substring that carries sailings — recorded in NOTES.md, Task 8. */
const RESULTS_MATCH = /* the substring you identified */ '';

export function shipUrl(ship) {
  const slug = ship.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.royalcaribbean.com/cruise-ships/${slug}`;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{limit: number}} options
 * @returns {Promise<string[]>} raw JSON payloads, in the order received
 */
export async function fetchListingPages(page, { limit }) {
  const payloads = [];

  page.on('response', async (response) => {
    if (!response.url().includes(RESULTS_MATCH)) return;
    if (!(response.headers()['content-type'] ?? '').includes('json')) return;
    try {
      payloads.push(await response.text());
    } catch {
      // Body no longer available; the next page load will produce another.
    }
  });

  await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
  await politeDelay();

  const wall = detectBotWall(await page.content());
  if (wall) throw new BotWallError(wall, SEARCH_URL);

  while (payloads.length * 20 < limit) {
    const more = await page.$(/* load-more selector from NOTES.md */);
    if (!more) break;
    await more.click();
    await politeDelay();
  }

  return payloads;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} ship
 * @returns {Promise<string>} raw HTML
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

- [ ] **Step 2: Verify against the live site**

```bash
node -e "
import('./browser.js').then(async (b) => {
  const rc = await import('./sites/royal-caribbean.js');
  const browser = await b.launch();
  const page = await b.newPage(browser);
  const payloads = await rc.fetchListingPages(page, { limit: 20 });
  const rows = payloads.flatMap(rc.parseListing);
  console.log('payloads:', payloads.length, 'rows:', rows.length);
  console.log(rows[0]);
  await browser.close();
});
"
```

Expected: at least one payload and a non-zero row count.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add sites/royal-caribbean.js
git commit -m "Fetch Royal Caribbean listings and ship pages"
```

---

### Task 10: The registry and the scrape CLI

**Files:**
- Create: `sites/index.js`
- Create: `scrape.js`
- Test: `test/scrape.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–9
- Produces:
  - `sites/index.js`: `ADAPTERS: Adapter[]`, `adaptersFor(names: string[]) => Adapter[]`
  - `scrape.js`: `parseFlags(argv: string[]) => { limit, sites, refreshShips, dryRun }`, and a `main()` that runs when invoked directly

`parseFlags` is pure and gets tests. The orchestration is verified by the end-to-end run in Task 11.

- [ ] **Step 1: Write the failing test**

Create `test/scrape.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../scrape.js';
import { ADAPTERS, adaptersFor } from '../sites/index.js';

test('both adapters are registered', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.name).sort(), ['princess', 'royal-caribbean']);
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
  assert.deepEqual(adaptersFor([]).map((a) => a.name).sort(), ['princess', 'royal-caribbean']);
  assert.deepEqual(adaptersFor(['princess']).map((a) => a.name), ['princess']);
});

test('adaptersFor rejects an unknown site rather than silently scraping nothing', () => {
  assert.throws(() => adaptersFor(['carnival']), /carnival/);
});

test('flags have sensible defaults', () => {
  assert.deepEqual(parseFlags([]), { limit: 200, sites: [], refreshShips: false, dryRun: false });
});

test('flags parse', () => {
  const flags = parseFlags(['--limit', '50', '--site', 'princess', '--refresh-ships', '--dry-run']);
  assert.equal(flags.limit, 50);
  assert.deepEqual(flags.sites, ['princess']);
  assert.equal(flags.refreshShips, true);
  assert.equal(flags.dryRun, true);
});

test('--site can be repeated', () => {
  assert.deepEqual(parseFlags(['--site', 'princess', '--site', 'royal-caribbean']).sites,
    ['princess', 'royal-caribbean']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../sites/index.js'`

- [ ] **Step 3: Write the registry**

Create `sites/index.js`:

```js
import * as princess from './princess.js';
import * as royalCaribbean from './royal-caribbean.js';

export const ADAPTERS = [princess, royalCaribbean];

/**
 * @param {string[]} names - empty means all
 * @returns {typeof ADAPTERS}
 */
export function adaptersFor(names) {
  if (names.length === 0) return ADAPTERS;

  return names.map((wanted) => {
    const adapter = ADAPTERS.find((a) => a.name === wanted);
    if (!adapter) {
      throw new Error(
        `Unknown site "${wanted}". Known sites: ${ADAPTERS.map((a) => a.name).join(', ')}`,
      );
    }
    return adapter;
  });
}
```

- [ ] **Step 4: Write the CLI**

Create `scrape.js`:

```js
#!/usr/bin/env node
/**
 * Collects sailings from every registered site and writes data/sailings.json.
 *
 *   node scrape.js [--limit N] [--site princess] [--refresh-ships] [--dry-run]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, newPage } from './browser.js';
import { BotWallError, EmptyResultError } from './errors.js';
import { normalizeAll } from './normalize.js';
import { deriveValues } from './values.js';
import { assertNonEmpty, loadExisting, mergeShips, writeResult } from './persist.js';
import { adaptersFor } from './sites/index.js';

const DATA_DIR = new URL('./data/', import.meta.url).pathname;

export function parseFlags(argv) {
  const flags = { limit: 200, sites: [], refreshShips: false, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') flags.limit = Number(argv[i + 1]);
    else if (argv[i] === '--site') flags.sites.push(argv[i + 1]);
    else if (argv[i] === '--refresh-ships') flags.refreshShips = true;
    else if (argv[i] === '--dry-run') flags.dryRun = true;
  }

  return flags;
}

async function snapshotFailure(body, label) {
  await mkdir(join(DATA_DIR, 'debug'), { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const path = join(DATA_DIR, 'debug', `${label}-${stamp}.txt`);
  await writeFile(path, body, 'utf8');
  return path;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const adapters = adaptersFor(flags.sites);

  const browser = await launch();
  const allSailings = [];
  const allMisses = [];
  const freshShips = {};
  const failures = [];

  for (const adapter of adapters) {
    const page = await newPage(browser);
    try {
      const payloads = await adapter.fetchListingPages(page, { limit: flags.limit });
      const rows = payloads.flatMap((p) => adapter.parseListing(p));

      // Zero rows means something broke. Never let it become an empty file.
      assertNonEmpty(rows, `${adapter.name} listing`);

      const { sailings, unrecognised } = normalizeAll(rows.slice(0, flags.limit), {
        source: adapter.name,
        line: adapter.line,
      });
      allSailings.push(...sailings);
      allMisses.push(...unrecognised);
      console.log(`${adapter.name}: ${sailings.length} sailings`);
    } catch (err) {
      // Both of these abort without writing, and both save the page that caused
      // them — but they need different fixes, so they must not read alike.
      if (err instanceof BotWallError) {
        const path = await snapshotFailure(await page.content(), `${adapter.name}-wall`);
        console.error(`${adapter.name}: BOT WALL — ${err.reason}.`);
        console.error(`  This is a block, not a parse failure. Body saved to ${path}`);
      } else if (err instanceof EmptyResultError) {
        const path = await snapshotFailure(await page.content(), `${adapter.name}-empty`);
        console.error(`${adapter.name}: parsed 0 sailings.`);
        console.error(`  Selectors probably broke. Page saved to ${path}`);
        console.error('  Not writing data/sailings.json — the previous run is preserved.');
      } else {
        console.error(`${adapter.name}: ${err.message}`);
      }
      failures.push(`${adapter.name} listing: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  const existing = (await loadExisting(DATA_DIR)) ?? { ships: {} };
  const wantedShips = [...new Set(allSailings.map((s) => s.ship))];
  const needed = flags.refreshShips
    ? wantedShips
    : wantedShips.filter((ship) => !existing.ships?.[ship]);

  for (const ship of needed) {
    const adapter = adapters.find((a) => allSailings.some((s) => s.ship === ship && s.source === a.name));
    if (!adapter) continue;

    const page = await newPage(browser);
    try {
      const html = await adapter.fetchShipPage(page, ship);
      freshShips[ship] = { ...adapter.parseShip(html), url: adapter.shipUrl(ship) };
    } catch (err) {
      // A failed ship page must not kill the run — the sailing is still good.
      console.error(`ship "${ship}": ${err.message}`);
      failures.push(`ship "${ship}": ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  const result = {
    scrapedAt: new Date().toISOString(),
    sailings: allSailings,
    ships: mergeShips(existing.ships ?? {}, freshShips, { refresh: flags.refreshShips }),
    values: deriveValues(allSailings),
    unrecognised: allMisses,
  };

  if (flags.dryRun) {
    console.log(JSON.stringify({ ...result, sailings: result.sailings.slice(0, 3) }, null, 2));
    console.log(`\nDRY RUN — ${result.sailings.length} sailings, nothing written.`);
  } else {
    assertNonEmpty(result.sailings, 'the whole run');
    const path = await writeResult(DATA_DIR, result);
    console.log(`\nWrote ${result.sailings.length} sailings to ${path}`);
  }

  if (result.unrecognised.length > 0) {
    console.log(`\n${result.unrecognised.length} unrecognised values — add aliases to normalize.js:`);
    for (const miss of result.unrecognised) {
      console.log(`  ${miss.field}: "${miss.raw}" (${miss.count}x)`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add sites/index.js scrape.js test/scrape.test.js
git commit -m "Add the adapter registry and the scrape CLI"
```

---

### Task 11: End-to-end verification

**Files:**
- Modify: `test/fixtures/NOTES.md` (record the observed run)
- Modify: `CLAUDE.md` (add a "Running it" section)

**Interfaces:**
- Consumes: everything
- Produces: a verified `data/sailings.json`

- [ ] **Step 1: Dry run**

```bash
node scrape.js --limit 5 --dry-run
```

Expected: three sample sailings printed, "DRY RUN — N sailings, nothing written", and no change to `data/`.

- [ ] **Step 2: Real run**

```bash
node scrape.js --limit 50
```

Expected: per-site counts, then "Wrote N sailings to …/data/sailings.json".

- [ ] **Step 3: Check the success criteria from the spec**

```bash
node -e "
const d = require('./data/sailings.json');
const req = ['line','ship','departureDate','nights','price'];
const bad = d.sailings.filter(s => req.some(f => s[f] === null || s[f] === undefined));
const missingShips = [...new Set(d.sailings.map(s => s.ship))].filter(s => !d.ships[s]);
console.log('sailings:', d.sailings.length, d.sailings.length >= 40 ? 'OK' : 'FAIL (want >= 40)');
console.log('incomplete sailings:', bad.length, bad.length === 0 ? 'OK' : 'FAIL');
console.log('empty enumerations:', Object.entries(d.values).filter(([,v]) => v.length === 0).map(([k]) => k));
console.log('ships without a description:', missingShips.length, missingShips.length === 0 ? 'OK' : 'FAIL');
console.log('unrecognised values:', d.unrecognised.length);
"
```

Expected: `sailings` at least 40, zero incomplete sailings, no empty enumerations, zero ships without a description.

If `unrecognised` is non-empty, add the missing aliases to `normalize.js`, re-run `npm test`, and scrape again. That list is the tool telling you exactly what it did not understand — working through it to empty is the last step of getting the data right.

- [ ] **Step 4: Confirm the empty-result guard actually guards**

Temporarily break a selector — in `sites/princess.js`, change `RESULTS_MATCH` to `'nothing-matches-this'` — and run:

```bash
node scrape.js --limit 5
```

Expected: a `Parsed 0 rows` error, exit code 1, and **`data/sailings.json` unchanged** (check its timestamp with `ls -l data/`). Then revert the change.

This is the single most important behaviour in the whole scraper. Verify it deliberately rather than assuming it.

- [ ] **Step 5: Document how to run it**

Add to `CLAUDE.md`:

```markdown
## Running it

    npm test                       # unit tests, no network
    node scrape.js --limit 5 --dry-run   # smoke test, writes nothing
    node scrape.js                 # real run, writes data/sailings.json

Fixtures in `test/fixtures/` are real captured payloads. When a site changes shape,
re-capture with `node tools/capture-fixture.js` and update the golden first-row files.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md test/fixtures/NOTES.md
git commit -m "Verify the scraper end to end and document how to run it"
```

---

## Notes for the implementer

**When a site changes shape,** the golden-row tests fail with a clear diff. Re-capture the fixture with `tools/capture-fixture.js`, update the golden file to match reality, and fix the parser. Do not edit the assertions to match a broken parser.

**When you meet a bot wall,** stop and report it. Do not add stealth plugins, rotate user agents, or route around the block — the spec rules that out explicitly, and a scraper that fights a vendor is a scraper that breaks weekly.

**The search-layer empty states are not in this plan.** The spec specifies two of
them — the "you've had enough sun anyway" no-match message and the unmappable-term
message — but both belong to the search UI, which is a separate piece of work. This
plan delivers only the data they depend on.

**`normalize.js` is expected to grow.** Every real run surfaces destination and cabin labels the maps do not know. Adding them is routine maintenance, and the `unrecognised` list in `data/sailings.json` is the to-do list.
