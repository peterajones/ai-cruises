# Princess Adapter Implementation Plan

**Status:** COMPLETE

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Princess Cruises as adapter #3, scraping the rendered search-results page for per-departure dates and prices.

**Architecture:** Unlike Royal Caribbean and Celebrity, Princess's JSON API cannot produce a dated price — its catalog has dates without prices, its pricing endpoint has prices without dates, and for ~9% of itineraries the join is genuinely ambiguous. The rendered results page carries both on one card, so this adapter parses the DOM. Fetching drives per-ship pages and scroll-to-load; parsing stays a pure function over captured HTML, same as the other two.

**Tech Stack:** Node 22, Puppeteer, `node --test`. No new dependencies.

## Global Constraints

- Node 22+, ESM. Exactly two runtime dependencies project-wide: `puppeteer` and `@anthropic-ai/sdk`. Add nothing — no HTML parser, no date library.
- Tests are `node --test` via `npm test`, glob form `node --test 'test/*.test.js'`.
- No model/AI calls anywhere in the scraper.
- Canonical values are lowercase kebab-case. Dates are ISO 8601 `YYYY-MM-DD` strings.
- Adapters return **site-shaped** rows and never canonicalize — that is `normalize.js`'s job.
- Adapters are independent files, never a shared base class. When one site changes shape, the others keep running.
- Politeness: one browser, sequential loads, `politeDelay()` between every navigation, no concurrency.
- Never evade a bot wall. If `detectBotWall` fires, throw `BotWallError` and stop.
- Fixtures in `test/fixtures/` are real captures only. Synthetic test data goes inline in test files.
- `data/sailings.json` is written only via `persist.js`.

## Known Facts (verified 2026-08-05, do not re-derive)

- Results URL: `https://www.princess.com/cruise-search/results/?ship=<CODE>`
- 17 ship codes live in `test/fixtures/princess-ships-ref.json` (`{ships: [{id, name}]}`).
- The list lazy-loads: 10 cards initially, 20 after scrolling. Scroll until the count stops growing.
- Of those 20 cards, **only 15 carry a departure date** — the rest are promo tiles. Filter on the
  presence of `.date-ship`, and never assume card count equals sailing count.
- **Prices are CAD**, not USD. `?currency=USD` and the `/en-us/` path were both tried and ignored. Store `currency: 'CAD'` honestly. Do **not** convert.
- Price basis otherwise matches the other lines: per person, taxes and fees included.
- A committed fixture already exists: `test/fixtures/princess-results.html` (1.74 MB, 20 cards, ship DI).

### Verified DOM structure

Each departure is one `div.product-details-date-wrapper`, 20 per captured page:

```html
<div class="... product-details-date-wrapper ...">
  <div class="product-dates top-spacing-10">
    <div class="col-xs-6 date-ship ...">Wed, Dec 09, 2026 on Diamond Princess</div>
    <span class="visuallyhidden">Wednesday, December 09, 2026  on Diamond Princess</span>
  </div>
  <div class="product-pricing">
    <div class="font-size-p2 ...">Interior from*</div>
    <span class="font-before-price">Was</span><span class="amount">$2362</span>
    <div class="price align-center">
      <span class="font-before-price">Now</span><span class="amount">$1,142</span>
    </div>
  </div>
</div>
```

The itinerary title and ports sit on the enclosing `div.coveo-result-card`, e.g.
`7-Day Japan & Korea Roundtrip from Tokyo, Japan` and `5 Ports: Tokyo, Japan  Toba, Japan …`.

---

### Task 1: Parse one departure card

**Files:**
- Create: `sites/princess.js` (parse functions only — `fetch*` comes in Task 3)
- Create: `test/fixtures/princess-first-row.json` (golden, generated then hand-checked)
- Test: `test/princess.test.js`

**Interfaces:**
- Consumes: `test/fixtures/princess-results.html`
- Produces:
  - `name = 'princess'`, `line = 'Princess Cruises'`
  - `parseListing(html: string) => RawSailing[]` — pure
  - `RawSailing` keys exactly: `externalId, url, ship, departurePort, destination, departureDate, nights, cabin, price, currency, itinerary, image, ports`

**Field mapping — derive each from the card text, not from a JSON path:**

| Field | Source |
|---|---|
| `ship` | text after `" on "` in `.date-ship` → `Diamond Princess` |
| `departureDate` | text before `" on "` in `.date-ship` → `Wed, Dec 09, 2026` → convert to `2026-12-09` |
| `cabin` | text before `" from*"` in `.product-pricing` → `Interior` |
| `price` | the **`Now`** amount, not `Was`. `$1,142` → `1142` |
| `currency` | the literal string `'CAD'` (verified; the page says "Price in CAD") |
| `nights` | leading digits of the card title → `7-Day Japan & Korea…` → `7` |
| `itinerary` | the card title verbatim |
| `departurePort` | text after `"from "` in the title → `Tokyo, Japan` |
| `destination` | first port's country, or the title's region word — see Step 4 |
| `ports` | the `N Ports:` list on the card |
| `externalId` | `` `${ship}_${departureDate}` `` slugified — Princess exposes no per-departure id in the DOM |
| `url` | the card's detail `<a href>`, prefixed with `https://www.princess.com` if relative |
| `image` | the card's `<img src>`, absolutised the same way |

- [x] **Step 1: Write the failing test**

Create `test/princess.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, name, line } from '../sites/princess.js';
import { normalizeAll } from '../normalize.js';

const html = await readFile(new URL('./fixtures/princess-results.html', import.meta.url), 'utf8');

test('the adapter identifies itself', () => {
  assert.equal(name, 'princess');
  assert.equal(line, 'Princess Cruises');
});

test('parses one row per DATED departure card', () => {
  // Verified against the fixture: splitting on .coveo-result-card yields 20 cards,
  // but only 15 carry a .date-ship element. The other 5 are promo tiles
  // ("Up to 40% Off", "FREE 3rd & 4th Guests") with no departure on them.
  // Counting cards instead of dated cards would inflate this to 20 and then fail
  // downstream when 5 rows had no date.
  assert.equal(parseListing(html).length, 15);
});

test('every row carries the fields normalizeAll requires', () => {
  for (const row of parseListing(html)) {
    for (const field of ['externalId', 'ship', 'departureDate', 'nights', 'price']) {
      assert.ok(row[field], `missing ${field}: ${JSON.stringify(row)}`);
    }
  }
});

test('dates are converted from the page format to ISO', () => {
  for (const row of parseListing(html)) {
    assert.match(row.departureDate, /^\d{4}-\d{2}-\d{2}$/, `not ISO: ${row.departureDate}`);
  }
});

// Princess quotes Canadian dollars. Royal Caribbean and Celebrity quote USD.
// Storing 'USD' here would make every cross-line price comparison silently wrong.
test('currency is CAD, never USD', () => {
  for (const row of parseListing(html)) {
    assert.equal(row.currency, 'CAD', 'Princess prices are CAD — do not convert or relabel');
  }
});

// The card shows a struck-through "Was" price above the real "Now" price.
// Taking the first amount on the card would systematically overstate every fare.
test('price is the Now amount, not the struck-through Was amount', () => {
  const rows = parseListing(html);
  const dec9 = rows.find((r) => r.departureDate === '2026-12-09');
  assert.ok(dec9, 'expected the 2026-12-09 Diamond Princess departure in the fixture');
  assert.equal(dec9.price, 1142, 'took the Was price (2362) instead of the Now price (1142)');
});

test('ship names are real, not slugs or codes', () => {
  for (const row of parseListing(html)) {
    assert.match(row.ship, /^[A-Z][a-z]+ Princess$/, `unexpected ship name: ${row.ship}`);
  }
});

test('nights is a number taken from the itinerary title', () => {
  for (const row of parseListing(html)) {
    assert.ok(Number(row.nights) > 0 && Number(row.nights) < 200, `bad nights: ${row.nights}`);
  }
});

test('the fixture survives normalizeAll with no dropped rows', () => {
  const rows = parseListing(html);
  const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
  assert.equal(
    sailings.length,
    rows.length,
    `dropped: ${JSON.stringify(unrecognised.filter((u) => u.field === 'row'), null, 2)}`,
  );
});

test('an unrecognised page yields no rows rather than throwing', () => {
  assert.deepEqual(parseListing('<html><body>nothing here</body></html>'), []);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../sites/princess.js'`

- [x] **Step 3: Write the parser**

Create `sites/princess.js`. No HTML parser is permitted, so split the document on the card
boundary and regex within each card:

```js
/**
 * Princess Cruises adapter. Knows about princess.com and nothing else.
 *
 * Unlike the Royal Caribbean and Celebrity adapters, this one parses the RENDERED
 * results page rather than a JSON API. That is not a preference — Princess's API
 * cannot produce a dated price. Its catalog carries dates without prices, its
 * pricing endpoint carries prices without any date field at all, and for ~9% of
 * itineraries (10 of 117 for ship DI) one price maps to several sail dates with
 * no way to tell which. The rendered card carries both on one element, so the
 * DOM is the only source that answers the question.
 *
 * Prices are CANADIAN DOLLARS. `?currency=USD` and the /en-us/ path were both
 * tried and ignored. Store CAD honestly; converting would invent a rate.
 */

export const name = 'princess';
export const line = 'Princess Cruises';

const SITE_ORIGIN = 'https://www.princess.com';

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "Wed, Dec 09, 2026" -> "2026-12-09". Returns null on anything else. */
function toIsoDate(text) {
  const m = String(text ?? '').match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${String(m[2]).padStart(2, '0')}`;
}

/** Strip tags and collapse whitespace. */
function text(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : `${SITE_ORIGIN}${url}`;
}

/**
 * @param {string} html - a rendered results page
 * @returns {object[]} RawSailing rows, one per departure card
 */
export function parseListing(html) {
  const doc = String(html ?? '');
  const rows = [];

  // Each result card is one .coveo-result-card; each carries its own departure.
  const cards = doc.split(/<div[^>]*class="[^"]*\bcoveo-result-card\b/).slice(1);

  for (const card of cards) {
    const dateShip = text((card.match(/class="[^"]*\bdate-ship\b[^"]*"[^>]*>([\s\S]*?)<\/div>/) ?? [])[1]);
    if (!dateShip.includes(' on ')) continue;

    const departureDate = toIsoDate(dateShip.split(' on ')[0]);
    const ship = dateShip.split(' on ')[1]?.trim();
    if (!departureDate || !ship) continue;

    // "Interior from*" -> cabin label
    const cabin = (text((card.match(/>([^<]*?)\s*from\*/) ?? [])[1]) || null);

    // The card shows "Was $2362" then "Now $1,142". Take the Now amount.
    const nowBlock = card.match(/class="[^"]*\bprice\b[^"]*"[\s\S]{0,400}?class="[^"]*\bamount\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const price = Number(text(nowBlock?.[1]).replace(/[^0-9.]/g, '')) || null;

    // Title: "7-Day Japan & Korea Roundtrip from Tokyo, Japan"
    const title = text((card.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/) ?? [])[1]);
    const nights = Number((title.match(/(\d+)\s*-?\s*Day/i) ?? [])[1]) || null;
    const departurePort = (title.split(/\bfrom\b/i)[1] ?? '').trim() || null;

    // "5 Ports: Tokyo, Japan  Toba, Japan  ..."
    const portsText = text((card.match(/\d+\s*Ports?:([\s\S]{0,400}?)<\//) ?? [])[1]);
    const ports = portsText
      ? portsText.split(/\s{2,}|,(?=\s*[A-Z])/).map((p) => p.trim()).filter(Boolean)
      : [];

    const href = (card.match(/<a[^>]+href="([^"]+)"/) ?? [])[1];
    const img = (card.match(/<img[^>]+src="([^"]+)"/) ?? [])[1];

    rows.push({
      externalId: `${ship}_${departureDate}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      url: absolute(href),
      ship,
      departurePort,
      destination: departurePort ? departurePort.split(',').pop().trim() : null,
      departureDate,
      nights,
      cabin,
      price,
      currency: 'CAD',
      itinerary: title || null,
      image: absolute(img),
      ports,
    });
  }

  return rows;
}
```

- [x] **Step 4: Run the tests and fix what the fixture disagrees with**

Run: `npm test`

The regexes above are written from the verified structure, but real markup always
differs in details. When a test fails, read the actual fixture rather than loosening
the assertion:

```bash
node -e "const h=require('fs').readFileSync('test/fixtures/princess-results.html','utf8');const i=h.indexOf('date-ship');console.log(h.slice(i-400,i+900))"
```

Two failures are expected and are **not** reasons to weaken a test:
- **`destination`** may come out as a country (`Japan`) that `normalize.js` does not know.
  Leave the adapter alone — Task 2 handles the mapping.
- **`ports`** splitting may need adjusting; the separator in the fixture is authoritative.

- [x] **Step 5: Write the golden row and assert it**

Generate it from your own parser, then **open the fixture and confirm every value is
really on the page** before committing:

```bash
node --input-type=module -e "
import { parseListing } from './sites/princess.js';
import { readFile, writeFile } from 'node:fs/promises';
const rows = parseListing(await readFile('test/fixtures/princess-results.html','utf8'));
await writeFile('test/fixtures/princess-first-row.json', JSON.stringify(rows[0], null, 2)+'\n');
console.log(JSON.stringify(rows[0], null, 2));
"
```

Add to `test/princess.test.js`:

```js
const golden = JSON.parse(
  await readFile(new URL('./fixtures/princess-first-row.json', import.meta.url), 'utf8'),
);

test('the first row matches the hand-checked golden row', () => {
  assert.deepEqual(parseListing(html)[0], golden);
});
```

- [x] **Step 6: Commit**

```bash
git add sites/princess.js test/princess.test.js test/fixtures/princess-first-row.json test/fixtures/princess-results.html
git commit -m "Parse Princess departure cards from the rendered results page"
```

---

### Task 2: Map Princess's destinations and cabin tiers

**Files:**
- Modify: `normalize.js` (`DESTINATIONS` and `CABINS` alias lists)
- Test: `test/normalize.test.js`

**Interfaces:**
- Consumes: `parseListing` from Task 1
- Produces: nothing new — extends existing alias maps

Princess names regions and cabins differently from the other two lines. Every unmapped
value must be resolved from evidence on the page, never guessed — the same rule that
settled Celebrity's `AQUA` and `CONCIERGE`.

- [x] **Step 1: Find out what actually needs mapping**

```bash
node --input-type=module -e "
import { parseListing, name, line } from './sites/princess.js';
import { normalizeAll } from './normalize.js';
import { readFile } from 'node:fs/promises';
const rows = parseListing(await readFile('test/fixtures/princess-results.html','utf8'));
const { unrecognised } = normalizeAll(rows, { source: name, line });
console.log(JSON.stringify(unrecognised, null, 2));
console.log('raw destinations:', JSON.stringify([...new Set(rows.map(r=>r.destination))]));
console.log('raw cabins      :', JSON.stringify([...new Set(rows.map(r=>r.cabin))]));
"
```

- [x] **Step 2: Write failing tests for exactly the values that appeared**

Add to `test/normalize.test.js`, using the values Step 1 printed — not invented ones:

```js
test("Princess's labels map", () => {
  // Evidence: these are the raw values parseListing produces from the captured
  // results page. Run the unrecognised check in the plan's Task 2 Step 1 to
  // regenerate this list if the fixture is re-captured.
  assert.equal(canonicalCabin('Interior'), 'interior');
  assert.equal(canonicalCabin('Oceanview'), 'oceanview');
  assert.equal(canonicalCabin('Balcony'), 'balcony');
  assert.equal(canonicalDestination('Japan'), 'asia');
});
```

- [x] **Step 3: Run to verify it fails**

Run: `npm test`
Expected: FAIL on whichever mapping is genuinely missing.

- [x] **Step 4: Add the aliases with a comment recording the evidence**

In `normalize.js`, extend the existing lists. Example shape:

```js
  'asia': ['asia', 'southeast asia', 'japan', 'far east', 'south korea', 'taiwan'],
```

Rules:
- Only add a value you saw in Step 1's output.
- If a Princess destination is coarser or finer than an existing canonical value, keep the
  source's granularity — do not invent precision, the same call made for Celebrity's
  `Europe`.
- If a value is genuinely ambiguous, leave it unmapped. An unrecognised value you can see
  beats a wrong mapping you cannot.

- [x] **Step 5: Verify nothing regressed and unrecognised is empty**

```bash
npm test
node --input-type=module -e "
import { parseListing, name, line } from './sites/princess.js';
import { normalizeAll } from './normalize.js';
import { readFile } from 'node:fs/promises';
const rows = parseListing(await readFile('test/fixtures/princess-results.html','utf8'));
const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
console.log('rows', rows.length, '-> sailings', sailings.length, '| unrecognised', JSON.stringify(unrecognised));
"
```

Expected: no dropped rows, `unrecognised` empty. Confirm the other two adapters still
report `unrecognised: []` as well — the alias lists are shared.

- [x] **Step 6: Commit**

```bash
git add normalize.js test/normalize.test.js
git commit -m "Map Princess destination and cabin labels"
```

---

### Task 3: Fetch per ship, with scroll-to-load

**Files:**
- Modify: `sites/princess.js` (add `fetchListingPages`, `fetchShipPage`, `shipUrl`)
- Modify: `test/princess.test.js` (add `shipUrl` tests)

**Interfaces:**
- Consumes: `launch`, `newPage`, `politeDelay`, `detectBotWall` from `browser.js`; `BotWallError` from `errors.js`
- Produces:
  - `fetchListingPages(page, { limit }) => Promise<string[]>` — one rendered HTML string per ship
  - `fetchShipPage(page, ship) => Promise<string>`
  - `shipUrl(ship) => string`

- [x] **Step 1: Add the fetch half**

Add these imports to the **top** of `sites/princess.js` (ESM hoists them, but putting
imports mid-file is how you end up with two import blocks that drift apart):

```js
import { readFile } from 'node:fs/promises';
import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';
```

Then append the rest:

```js

const RESULTS_URL = `${SITE_ORIGIN}/cruise-search/results/`;

/** Ship codes come from a reference table captured with the fixtures. */
async function shipCodes() {
  const ref = JSON.parse(
    await readFile(new URL('../test/fixtures/princess-ships-ref.json', import.meta.url), 'utf8'),
  );
  return ref.ships.map((s) => s.id);
}

export function shipUrl(ship) {
  const slug = String(ship).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${SITE_ORIGIN}/ships/${slug}`;
}

/**
 * Scrolls until the card count stops growing, then returns the rendered HTML.
 *
 * The list lazy-loads: 10 cards on arrival, 20 after one scroll. Bounded at 15
 * iterations so a site change cannot spin forever, and every scroll is spaced by
 * politeDelay.
 */
async function loadAllCards(page) {
  let previous = -1;
  for (let i = 0; i < 15; i += 1) {
    const count = await page.evaluate(
      () => document.querySelectorAll('.product-details-date-wrapper').length,
    );
    if (count === previous) break;
    previous = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await politeDelay(2500);
  }
  return page.content();
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{limit: number}} options - `limit` caps how many SHIPS are visited, so a
 *   small limit means a short run rather than a full 17-ship crawl.
 * @returns {Promise<string[]>} one rendered results page per ship
 */
export async function fetchListingPages(page, { limit }) {
  const codes = await shipCodes();
  const wanted = Number.isFinite(limit) ? codes.slice(0, Math.max(1, Math.ceil(limit / 20))) : codes;
  const pages = [];

  for (const code of wanted) {
    const url = `${RESULTS_URL}?ship=${code}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
    await politeDelay();

    const html = await loadAllCards(page);
    const wall = detectBotWall(html);
    if (wall) throw new BotWallError(wall, url);

    pages.push(html);
  }

  return pages;
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

- [x] **Step 2: Add a test for the pure part**

In `test/princess.test.js`, add `shipUrl` to the **existing** import from
`../sites/princess.js` rather than writing a second import line, then add:

```js
test('shipUrl slugifies to a princess.com path', () => {
  assert.equal(shipUrl('Diamond Princess'), 'https://www.princess.com/ships/diamond-princess');
  assert.equal(shipUrl('Sun Princess'), 'https://www.princess.com/ships/sun-princess');
});
```

- [x] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS. `fetchListingPages` is not unit-tested — it needs the live site.

- [x] **Step 4: Verify against the live site with a two-ship run**

```bash
node --input-type=module -e "
import { launch, newPage } from './browser.js';
import * as p from './sites/princess.js';
const b = await launch();
try {
  const page = await newPage(b);
  const pages = await p.fetchListingPages(page, { limit: 40 });
  const rows = pages.flatMap(h => p.parseListing(h));
  console.log('pages:', pages.length, '| rows:', rows.length);
  console.log(rows[0]);
} finally { await b.close(); }
"
```

Expected: 2 pages, roughly 20 rows each, a first row that looks like the golden row.

- [x] **Step 5: Commit**

```bash
git add sites/princess.js test/princess.test.js
git commit -m "Fetch Princess results per ship, scrolling until the list stops growing"
```

---

### Task 4: Register the adapter and confirm the mixed-currency dataset

**Files:**
- Modify: `sites/index.js`
- Modify: `test/scrape.test.js`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–3
- Produces: a three-line dataset

- [x] **Step 1: Register it**

In `sites/index.js`:

```js
import * as princess from './princess.js';

export const ADAPTERS = [royalCaribbean, celebrity, princess];
```

- [x] **Step 2: Update the registry assertions**

In `test/scrape.test.js`, both places currently listing two adapters:

```js
assert.deepEqual(ADAPTERS.map((a) => a.name), ['royal-caribbean', 'celebrity', 'princess']);
assert.deepEqual(adaptersFor([]).map((a) => a.name), ['royal-caribbean', 'celebrity', 'princess']);
```

- [x] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS.

- [x] **Step 4: Smoke-test one Princess ship, then run the full scrape**

```bash
node scrape.js --site princess --limit 20
node scrape.js
```

Expected: three per-line counts, then a total. Princess adds roughly 17 × 20 rows.

- [x] **Step 5: Confirm the dataset and surface the currency split**

```bash
node -p "
const d=require('./data/sailings.json');
const by={}, cur={};
d.sailings.forEach(s=>{by[s.line]=(by[s.line]||0)+1; cur[s.currency]=(cur[s.currency]||0)+1;});
'sailings '+d.sailings.length+' '+JSON.stringify(by)+
'\ncurrencies '+JSON.stringify(cur)+
'\nunique ids '+new Set(d.sailings.map(s=>s.id)).size+
'\nunrecognised '+d.unrecognised.length"
```

Expected: three lines, `{"USD": …, "CAD": …}`, unique ids equal to the sailing count,
`unrecognised` empty.

**This is the moment the deferred currency decision becomes live**, and the plan
deliberately stops short of acting on it. `search.js` compares `s.price <= filter.maxPrice`
with no regard to currency, so from this commit onward "under $800" compares CAD against
USD. Report the currency split to Peter and let him choose — the options recorded are:
make the filter currency-aware, convert at normalize time, or guard `search.js` to refuse
cross-currency comparison. Do not pick one unilaterally.

- [x] **Step 6: Update the docs**

In `CLAUDE.md`, replace the Princess section under `## Status` with what was actually
built: the DOM route and why (the API cannot produce a dated price), the CAD finding, the
per-ship scroll fetch, and the live cross-currency issue in `search.js`.

- [x] **Step 7: Commit**

```bash
git add sites/index.js test/scrape.test.js CLAUDE.md
git commit -m "Register the Princess adapter"
```

---

## Notes for the implementer

**Do not convert CAD to USD anywhere in this plan.** It is the single easiest way to make
the dataset quietly wrong. A stored rate goes stale, and an inferred price is a number the
source never published. Store what the page says and let a human decide what to do about it.

**When the DOM disagrees with this plan, the DOM wins.** These selectors were verified
against a capture taken 2026-08-05; a marketing site changes without notice. Re-capture with
the command in Task 3 Step 4 and update the golden row — never loosen an assertion to make a
stale selector pass.

**Zero rows from a real page is a failure, not an empty ocean.** `scrape.js` already treats
it that way via `assertNonEmpty`; do not add a code path that swallows it.

**If a bot wall appears, stop and report it.** Princess showed none across ~20 page loads
during discovery, but this adapter makes 17 navigations plus scrolling, which is more
traffic than either existing adapter generates.
