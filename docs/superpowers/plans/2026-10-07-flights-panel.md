# Flights Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a cruise and see roughly what flying there and back costs — home airport to the port the day before sailing, home from where the cruise ends on the day it ends.

**Architecture:** Each sailing gains `endPort` (from its adapter) and `endDate` (computed). `airports.js` maps port text to an airport code by rules. `flights.js` plans the trip, builds the SerpApi Google Flights request, reduces the response, and caches results in `data/flights-cache.json` for three days. `server.js` exposes `GET /api/flights`; a slide-out panel in `public/index.html` calls it.

**Tech Stack:** Node 22 (ESM), built-in `fetch`, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-flights-panel-design.md` — read it first.

## Global Constraints

- Node 22, ESM. Dependencies stay `puppeteer` and `@anthropic-ai/sdk`. No new packages.
- The key is `process.env.SERP_API_KEY`. It never reaches the browser, a log line, a test fixture or a commit.
- Flights are priced in the cruise's own currency (`sailing.currency`), per person, one adult.
- Out on `departureDate` − 1 day; home on `endDate`. Searches only when the outbound date is at most **330** days away.
- Cache entries are reused for **3** days. Errors are never cached; "no flights found" is.
- Live SerpApi searches cost Peter's quota (250/month). Tests never call SerpApi; they use saved responses and a fake `fetch`. Every live search in this plan is named and counted.
- No model calls outside `brain.js`.
- The project has a GitHub remote. Commit; never push — Peter pushes.

## Review Focus

1. **The home airport is one of the cruise's airports** (home SEA, a Seattle round trip). Expected: no search for a leg that goes nowhere; if neither leg needs a flight, "No flights needed" and no search. → Task 3.
2. **Data scraped before this change** (no `endPort`/`endDate`) while the server runs the new code. Expected: treated as a round trip from the departure port, ending `departureDate` + `nights`. → Task 3.
3. **The panel is opened twice for the same trip before the first search returns** (double click, or two cards with the same flights). Expected: one search, not two. → Task 4.
4. **SerpApi errors or the quota runs out.** Expected: the message is shown, and nothing is cached, so the next open tries again. → Task 4.
5. **A Princess one-way card's last listed port is not where it ends** (a shortened port list). Expected: the end port matches the site. Not testable offline; checked live in Task 6.

---

### Task 1: `airports.js`

**Files:**
- Create: `airports.js`
- Test: `test/airports.test.js`

**Interfaces:**
- Produces: `airportFor(portText: string|null): string|null` (IATA code); `airportName(code: string): string|null` (a short city name for display).

- [ ] **Step 1: Write the failing tests**

Create `test/airports.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { airportFor, airportName } from '../airports.js';

// Every departure port in the 2026-10-07 data, and every end port seen in the fixtures
// and in Holland America's Alaska feed.
const PORTS = {
  'Vancouver, B.C., CA': 'YVR', 'Vancouver, Canada': 'YVR',
  'Fort Lauderdale': 'FLL', 'Ft. Lauderdale, Florida': 'FLL', 'Fort Lauderdale, Florida, US': 'FLL',
  'Fairbanks, Alaska': 'FAI', 'Miami': 'MIA', 'Miami, Florida': 'MIA',
  'Anchorage, Alaska, US': 'ANC', 'Whittier, Alaska, US': 'ANC',
  'Seattle': 'SEA', 'Seattle, Washington': 'SEA', 'Seattle, Washington, US': 'SEA',
  'Los Angeles, California': 'LAX', 'Tokyo, Japan': 'HND', 'Tokyo (Yokohama), Japan': 'HND',
  'Sydney, Australia': 'SYD', 'Port Canaveral (Orlando), Florida': 'MCO', 'Orlando (Port Canaveral)': 'MCO',
  'Barcelona': 'BCN', 'Barcelona, Spain': 'BCN', 'San Juan, Puerto Rico': 'SJU',
  'Southampton (for London), England': 'LHR', 'Brisbane, Australia': 'BNE',
  'San Francisco, California': 'SFO', 'Singapore': 'SIN',
  'New York City (Manhattan or Brooklyn), New York': 'JFK', 'Honolulu, Hawaii': 'HNL',
  'Copenhagen, Denmark': 'CPH', 'Barbados': 'BGI', 'Perth (Fremantle), Australia': 'PER',
  'Ravenna, Italy': 'BLQ', 'Civitavecchia (for Rome), Italy': 'FCO', 'Civitavecchia (Rome), Italy': 'FCO',
  'Athens (Piraeus), Greece': 'ATH', 'Athens (Piraeus)': 'ATH', 'Piraeus (Athens), Greece': 'ATH',
  'Trieste (for Venice), Italy': 'TRS', 'Trieste (Venice), Italy': 'TRS',
  'San Antonio (for Santiago), Chile': 'SCL', 'Buenos Aires, Argentina': 'EZE',
  'Helsinki, Finland': 'HEL', 'San Diego, California, US': 'SAN',
  'Amsterdam, The Netherlands': 'AMS', 'Rotterdam, The Netherlands': 'AMS',
  'Boston, Massachusetts, US': 'BOS', 'Montreal, Quebec, Canada': 'YUL',
  'Quebec City, Quebec, Canada': 'YQB', 'Reykjavik, Iceland': 'KEF',
  'Laem Chabang (for Bangkok),Thailand': 'BKK',
};

test('every known port maps to its airport', () => {
  for (const [port, code] of Object.entries(PORTS)) assert.equal(airportFor(port), code, port);
});

test('a port naming a nearby city maps to that city, not a namesake', () => {
  // "San Antonio (for Santiago)" is in Chile: SCL, never San Antonio, Texas.
  assert.equal(airportFor('San Antonio (for Santiago), Chile'), 'SCL');
  // Trieste names Venice too; the longer, more specific match wins.
  assert.equal(airportFor('Trieste (for Venice), Italy'), 'TRS');
});

test('an unknown port is null, never a guess', () => {
  assert.equal(airportFor('Nowhere Bay, Atlantis'), null);
  assert.equal(airportFor(''), null);
  assert.equal(airportFor(null), null);
});

test('codes have a name for display', () => {
  assert.equal(airportName('YYZ'), 'Toronto');
  assert.equal(airportName('ANC'), 'Anchorage');
  assert.equal(airportName('XXX'), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/airports.test.js`
Expected: FAIL — `Cannot find module '../airports.js'`.

- [ ] **Step 3: Implement**

Create `airports.js`:

```js
/**
 * Cruise port -> the airport you would fly to. No AI: a known place name found inside
 * the port text, longest match winning — the same approach as findDestination in
 * normalize.js. A port the table does not know is null, and the scrape reports it.
 */

/** IATA code -> [display name, ...names that appear in port text]. */
const AIRPORTS = {
  YYZ: ['Toronto', 'toronto'],
  YVR: ['Vancouver', 'vancouver'],
  SEA: ['Seattle', 'seattle'],
  // Whittier and Seward are Anchorage's cruise ports.
  ANC: ['Anchorage', 'anchorage', 'whittier', 'seward'],
  FAI: ['Fairbanks', 'fairbanks'],
  FLL: ['Fort Lauderdale', 'fort lauderdale', 'ft lauderdale'],
  MIA: ['Miami', 'miami'],
  MCO: ['Orlando', 'orlando', 'port canaveral'],
  LAX: ['Los Angeles', 'los angeles'],
  SFO: ['San Francisco', 'san francisco'],
  SAN: ['San Diego', 'san diego'],
  HNL: ['Honolulu', 'honolulu'],
  SJU: ['San Juan', 'san juan'],
  BGI: ['Barbados', 'barbados'],
  JFK: ['New York', 'new york'],
  BOS: ['Boston', 'boston'],
  YUL: ['Montreal', 'montreal'],
  YQB: ['Quebec City', 'quebec city'],
  KEF: ['Reykjavik', 'reykjavik'],
  LHR: ['London', 'london', 'southampton'],
  AMS: ['Amsterdam', 'amsterdam', 'rotterdam'],
  CPH: ['Copenhagen', 'copenhagen'],
  HEL: ['Helsinki', 'helsinki'],
  BCN: ['Barcelona', 'barcelona'],
  FCO: ['Rome', 'rome', 'civitavecchia'],
  VCE: ['Venice', 'venice'],
  TRS: ['Trieste', 'trieste'],
  // Ravenna's nearest airport with real service is Bologna.
  BLQ: ['Bologna', 'bologna', 'ravenna'],
  ATH: ['Athens', 'athens', 'piraeus'],
  HND: ['Tokyo', 'tokyo', 'yokohama'],
  SIN: ['Singapore', 'singapore'],
  BKK: ['Bangkok', 'bangkok', 'laem chabang'],
  SYD: ['Sydney', 'sydney'],
  BNE: ['Brisbane', 'brisbane'],
  PER: ['Perth', 'perth', 'fremantle'],
  // Deliberately no "san antonio": the Chilean port would match San Antonio, Texas.
  SCL: ['Santiago', 'santiago'],
  EZE: ['Buenos Aires', 'buenos aires'],
};

const key = (raw) => String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ALIASES = Object.entries(AIRPORTS).flatMap(([code, [, ...names]]) =>
  names.map((name) => [key(name), code]));

/**
 * @param {string|null} portText
 * @returns {string|null} IATA code
 */
export function airportFor(portText) {
  const haystack = key(portText);
  if (!haystack) return null;
  let best = null;
  let bestLength = 0;
  for (const [alias, code] of ALIASES) {
    if (alias.length <= bestLength) continue;
    if (new RegExp(`(^|\\s)${alias}($|\\s)`).test(haystack)) {
      best = code;
      bestLength = alias.length;
    }
  }
  return best;
}

/** @returns {string|null} a short city name for an airport code */
export function airportName(code) {
  return AIRPORTS[code]?.[0] ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add airports.js test/airports.test.js
git commit -m "Map cruise ports to airports"
```

---

### Task 2: Where each cruise ends

**Files:**
- Modify: `sites/royal-caribbean.js`, `sites/celebrity.js`, `sites/holland-america.js`, `sites/princess.js`
- Modify: `normalize.js` (`endPort`, `endDate`, airport reporting; export `addDays`)
- Modify: `test/fixtures/royal-caribbean-first-row.json`, `celebrity-first-row.json`, `princess-first-row.json`, `holland-america-first-row.json`, `holland-america-alaska-us.json` (recaptured)
- Test: `test/normalize.test.js`, the four adapter tests

**Interfaces:**
- Consumes: `airportFor` (Task 1).
- Produces: raw rows carry `endPort: string|null`. Normalized sailings carry `endPort: string|null` and `endDate: 'YYYY-MM-DD'|null`. `addDays(iso: string, days: number): string` exported from `normalize.js`. A port `airportFor` cannot map is reported as `{ field: 'airport', raw: <port> }`.

- [ ] **Step 1: Write the failing tests**

In `test/normalize.test.js`, add `addDays,` to the import list. The test `'a good row becomes a fully canonical Sailing'` compares the whole object: add, after `departureDate: '2027-01-16',`:

```js
    endPort: null,
    endDate: '2027-01-23',
```

Append:

```js
test('endDate is the departure date plus the nights', () => {
  const { sailings } = normalizeAll([{ ...goodRow, departureDate: '2027-05-09', nights: 7 }], { source: 'princess', line: 'Princess' });
  assert.equal(sailings[0].endDate, '2027-05-16');
  assert.equal(addDays('2027-12-30', 3), '2028-01-02');
  assert.equal(addDays('2027-05-09', -1), '2027-05-08');
});

test('endPort is kept, and a port with no known airport is reported', () => {
  const row = { ...goodRow, endPort: ' Whittier, Alaska, US ' };
  assert.equal(normalizeAll([row], { source: 'holland-america', line: 'Holland America' }).sailings[0].endPort, 'Whittier, Alaska, US');
  const odd = { ...goodRow, endPort: 'Nowhere Bay' };
  const { sailings, unrecognised } = normalizeAll([odd], { source: 'princess', line: 'Princess' });
  assert.equal(sailings.length, 1);
  assert.deepEqual(unrecognised, [{ field: 'airport', raw: 'Nowhere Bay', count: 1 }]);
});
```

Add `"endPort"` to each golden first-row file, directly after its `"departurePort"` line:

- `test/fixtures/royal-caribbean-first-row.json`: `"endPort": "Miami",`
- `test/fixtures/celebrity-first-row.json`: `"endPort": "Miami",`
- `test/fixtures/princess-first-row.json`: `"endPort": "Singapore",` (its card reads "Roundtrip from Singapore")

In `test/holland-america.test.js`, the inline first-row object in `'the first row reads as the captured sailing'`: add `endPort: 'Whittier, Alaska, US',` after `departurePort: 'Vancouver, B.C., CA',`. Append:

```js
test('the search asks for where the cruise ends', () => {
  assert.ok(new URL(searchUrl(0)).searchParams.get('fl').split(',').includes('disembarkPortName'));
});
```

Append to `test/princess.test.js`:

```js
test('a round trip ends where it began; every card has an end port', () => {
  const rows = parseListing(html);
  assert.equal(rows[0].endPort, rows[0].departurePort);
  assert.ok(rows.every((r) => r.endPort));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the canonical-Sailing test (no `endPort`/`endDate`), the two new normalize tests (`addDays` not exported), the three golden-row tests, the HAL inline row, the HAL `fl` test, the Princess end-port test.

- [ ] **Step 3: Implement `normalize.js`**

Add `import { airportFor } from './airports.js';` at the top. Add, before `normalizeAll`:

```js
/**
 * An ISO date moved by whole days, in UTC so no time zone shifts it.
 * @param {string} iso - YYYY-MM-DD
 * @param {number} days
 * @returns {string}
 */
export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
```

In the `sailing` object, after the `departurePort:` line:

```js
      endPort: row.endPort ? String(row.endPort).trim() : null,
```

and after `nights: toNumber(row.nights),`:

```js
      endDate: null,
```

After the `sailing.cabinPrices = …` line:

```js
    if (sailing.departureDate && sailing.nights != null) {
      sailing.endDate = addDays(sailing.departureDate, sailing.nights);
    }
    // A port with no airport cannot be priced for flights; the scrape lists it as a to-do.
    for (const port of new Set([sailing.departurePort, sailing.endPort])) {
      if (port && airportFor(port) === null) miss('airport', port);
    }
```

- [ ] **Step 4: Implement the adapters**

**Royal Caribbean and Celebrity** — in both files, after the `ports` array is built:

```js
    // Where the cruise ends: the port of the day the ship is left. Most return to where they began.
    const endPort = (it.days ?? []).flatMap((d) => d.ports ?? [])
      .find((p) => p.activity === 'DEBARK')?.port?.name ?? null;
```

and add `endPort,` to the pushed row after `departurePort,`.

**Holland America** — add `'disembarkPortName'` to `FIELDS` (after `'embarkPortName'`), and to the pushed row after `departurePort:`:

```js
      endPort: unpack(doc.disembarkPortName).value,
```

**Princess** — after `const departurePort = …`:

```js
    // "Roundtrip from X" ends where it began; a one-way card's last port is where it ends.
    const endPort = /roundtrip/i.test(portLine) ? departurePort : (ports.at(-1) ?? departurePort);
```

and add `endPort,` to the pushed row after `departurePort,`.

- [ ] **Step 5: Recapture the Holland America USD fixture**

One request to Holland America (not SerpApi):

```bash
node tools/capture-fixture.js --url "$(node -e 'import("./sites/holland-america.js").then(m => console.log(m.searchUrl(0)))')" --match halcruisesearch --out test/fixtures/holland-america-alaska-us.json
node -e 'import("./sites/holland-america.js").then(async m => { const fs = await import("node:fs"); const r = m.parseListing(fs.readFileSync("test/fixtures/holland-america-alaska-us.json","utf8"))[0]; console.log(r.externalId, r.departurePort, "->", r.endPort, r.price, JSON.stringify(r.cabinPrices)) })'
```

Expected: `D733_cruise Seattle, Washington, US -> Seattle, Washington, US`, with prices as before (959 interior) or changed by the market. Regenerate `test/fixtures/holland-america-first-row.json` from `parseListing(…)[0]`, then `git diff` it: only `endPort` should be new. If prices moved, update the cabin-table test in `test/holland-america.test.js` to the new values and say so in the commit message.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass. If a Holland America test reports `{ field: 'airport', … }`, add that port to `AIRPORTS` in `airports.js` (and to the `PORTS` table in `test/airports.test.js`).

- [ ] **Step 7: Commit**

```bash
git add normalize.js sites/ test/
git commit -m "Record where each cruise ends, and when"
```

---

### Task 3: `flights.js` — planning a trip and reading a response

**Files:**
- Create: `flights.js`
- Create: `test/fixtures/serpapi-multicity.json` (the spike's saved response), `test/fixtures/serpapi-roundtrip.json` (captured — **1 live search**)
- Test: `test/flights.test.js`

**Interfaces:**
- Consumes: `airportFor` (Task 1), `addDays` (Task 2).
- Produces:
  - `MAX_DAYS_AHEAD = 330`
  - `planFlights(sailing, home: string, today: 'YYYY-MM-DD'): { route: { home, outbound: {from, to, date}|null, inbound: {from, to, date}|null }, currency } | { reason, message }`
  - `searchParams(plan, apiKey: string): URLSearchParams`
  - `summarize(raw: object): { fromPrice, options: [{price, airlines, departs, stops, minutes}], googleFlightsUrl } | { reason, message, googleFlightsUrl? }`

- [ ] **Step 1: Save the multi-city fixture**

The spike's response for YYZ → YVR 2027-05-08, ANC → YYZ 2027-05-16 is in the session scratchpad as `serp-multicity.json`. Copy it to `test/fixtures/serpapi-multicity.json`, then confirm no key is in it:

```bash
grep -c api_key test/fixtures/serpapi-multicity.json   # expect 0
grep -cF "$(grep '^SERP_API_KEY=' .env | cut -d= -f2-)" test/fixtures/serpapi-multicity.json   # expect 0
```

If the scratchpad copy is gone, recapture it — **1 live search**:

```bash
node --env-file=.env --input-type=module -e '
const legs = [{ departure_id: "YYZ", arrival_id: "YVR", date: "2027-05-08" }, { departure_id: "ANC", arrival_id: "YYZ", date: "2027-05-16" }];
const p = new URLSearchParams({ engine: "google_flights", type: "3", multi_city_json: JSON.stringify(legs), currency: "USD", hl: "en", adults: "1", api_key: process.env.SERP_API_KEY });
const r = await fetch("https://serpapi.com/search.json?" + p); (await import("node:fs")).writeFileSync("test/fixtures/serpapi-multicity.json", await r.text());'
```

In that case the expected values in Step 2's multi-city test must be re-read from the new file.

- [ ] **Step 2: Write the failing tests**

Create `test/flights.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planFlights, searchParams, summarize, MAX_DAYS_AHEAD } from '../flights.js';

const multicity = JSON.parse(await readFile(new URL('./fixtures/serpapi-multicity.json', import.meta.url), 'utf8'));

// The spike's sailing: Westerdam, Vancouver -> Whittier, 9-16 May 2027.
const westerdam = {
  departurePort: 'Vancouver, B.C., CA', endPort: 'Whittier, Alaska, US',
  departureDate: '2027-05-09', nights: 7, endDate: '2027-05-16', currency: 'USD',
};
const TODAY = '2026-10-07';

test('a one-way cruise: into the start port the day before, home from the end port', () => {
  assert.deepEqual(planFlights(westerdam, 'YYZ', TODAY), {
    route: {
      home: 'YYZ',
      outbound: { from: 'YYZ', to: 'YVR', date: '2027-05-08' },
      inbound: { from: 'ANC', to: 'YYZ', date: '2027-05-16' },
    },
    currency: 'USD',
  });
});

test('a one-way cruise searches multi-city; a round trip searches a round trip', () => {
  const multi = searchParams(planFlights(westerdam, 'YYZ', TODAY), 'k');
  assert.equal(multi.get('type'), '3');
  assert.deepEqual(JSON.parse(multi.get('multi_city_json')), [
    { departure_id: 'YYZ', arrival_id: 'YVR', date: '2027-05-08' },
    { departure_id: 'ANC', arrival_id: 'YYZ', date: '2027-05-16' },
  ]);
  assert.equal(multi.get('currency'), 'USD');
  assert.equal(multi.get('engine'), 'google_flights');

  const seattle = { ...westerdam, departurePort: 'Seattle, Washington, US', endPort: 'Seattle, Washington, US' };
  const round = searchParams(planFlights(seattle, 'YYZ', TODAY), 'k');
  assert.equal(round.get('type'), '1');
  assert.equal(round.get('departure_id'), 'YYZ');
  assert.equal(round.get('arrival_id'), 'SEA');
  assert.equal(round.get('outbound_date'), '2027-05-08');
  assert.equal(round.get('return_date'), '2027-05-16');
});

test('data from before endPort existed is treated as a round trip', () => {
  const old = { departurePort: 'Seattle, Washington, US', departureDate: '2027-05-09', nights: 7, currency: 'USD' };
  const plan = planFlights(old, 'YYZ', TODAY);
  assert.deepEqual(plan.route.inbound, { from: 'SEA', to: 'YYZ', date: '2027-05-16' });
});

test('home at a cruise port: no flight for that leg; none at all if both', () => {
  const plan = planFlights(westerdam, 'YVR', TODAY);
  assert.equal(plan.route.outbound, null);
  const p = searchParams(plan, 'k');
  assert.equal(p.get('type'), '2');
  assert.equal(p.get('departure_id'), 'ANC');
  assert.equal(p.get('arrival_id'), 'YVR');
  assert.equal(p.get('outbound_date'), '2027-05-16');

  const seattle = { ...westerdam, departurePort: 'Seattle, Washington, US', endPort: 'Seattle, Washington, US' };
  assert.equal(planFlights(seattle, 'SEA', TODAY).reason, 'no-flights-needed');
});

test('an unknown port is refused before any search, and named', () => {
  const plan = planFlights({ ...westerdam, endPort: 'Nowhere Bay' }, 'YYZ', TODAY);
  assert.equal(plan.reason, 'no-airport');
  assert.match(plan.message, /Nowhere Bay/);
});

test('the 330-day limit is on the outbound date', () => {
  assert.equal(MAX_DAYS_AHEAD, 330);
  // 2026-10-07 + 330 days = 2027-09-02 (computed). Outbound = departure - 1.
  const at = (departureDate) => planFlights({ ...westerdam, departureDate, endDate: departureDate }, 'YYZ', '2026-10-07');
  assert.ok(at('2027-09-03').route);           // outbound 2027-09-02: day 330
  assert.equal(at('2027-09-04').reason, 'too-far'); // outbound 2027-09-03: day 331
});

test('a response is reduced to the cheapest price and the three cheapest options', () => {
  const s = summarize(multicity);
  assert.equal(s.fromPrice, 517);
  assert.deepEqual(s.options, [
    { price: 517, airlines: 'Flair Airlines', departs: '2027-05-08 07:40', stops: 0, minutes: 310 },
    { price: 543, airlines: 'Air Canada', departs: '2027-05-08 06:00', stops: 0, minutes: 304 },
    { price: 543, airlines: 'Air Canada', departs: '2027-05-08 07:00', stops: 0, minutes: 304 },
  ]);
  assert.match(s.googleFlightsUrl, /^https:\/\/www\.google\.com\/travel\/flights/);
});

test('"no results" and other errors become a reason and a message', () => {
  const none = summarize({ error: "Google Flights hasn't returned any results for this query." });
  assert.equal(none.reason, 'no-flights');
  assert.equal(none.message, 'No flights found for these dates');
  const quota = summarize({ error: 'Your account has run out of searches.' });
  assert.equal(quota.reason, 'search-error');
  assert.equal(quota.message, 'Your account has run out of searches.');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/flights.test.js`
Expected: FAIL — `Cannot find module '../flights.js'`.

- [ ] **Step 4: Implement**

Create `flights.js`:

```js
/**
 * Approximate airfares for a cruise, from SerpApi's Google Flights API. No AI.
 *
 * Out to the start port the day before sailing; home from the end port on the day it
 * ends. One search prices the whole trip: in the 2026-10-07 spike, a multi-city
 * search's first-leg prices were whole-trip prices. See
 * docs/superpowers/specs/2026-10-07-flights-panel-design.md.
 */

import { airportFor } from './airports.js';
import { addDays } from './normalize.js';

/** Airlines sell about 11 months ahead; a search further out finds nothing. */
export const MAX_DAYS_AHEAD = 330;

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * @param {object} sailing
 * @param {string} home - IATA code
 * @param {string} today - YYYY-MM-DD
 */
export function planFlights(sailing, home, today) {
  // Data scraped before endPort existed is treated as a round trip.
  const endPort = sailing.endPort === undefined ? sailing.departurePort : sailing.endPort;
  const start = airportFor(sailing.departurePort);
  const end = airportFor(endPort);
  if (!start) return { reason: 'no-airport', message: `No airport known for ${sailing.departurePort} yet` };
  if (!end) return { reason: 'no-airport', message: `No airport known for ${endPort ?? 'where this cruise ends'} yet` };

  const outDate = addDays(sailing.departureDate, -1);
  const homeDate = sailing.endDate ?? addDays(sailing.departureDate, sailing.nights);
  if (daysBetween(today, outDate) > MAX_DAYS_AHEAD) {
    return { reason: 'too-far', message: "Airfares aren't published this far ahead yet" };
  }

  const outbound = home === start ? null : { from: home, to: start, date: outDate };
  const inbound = home === end ? null : { from: end, to: home, date: homeDate };
  if (!outbound && !inbound) return { reason: 'no-flights-needed', message: 'No flights needed — this cruise starts and ends at your airport' };

  return { route: { home, outbound, inbound }, currency: sailing.currency };
}

/**
 * @param {{route: object, currency: string}} plan
 * @param {string} apiKey
 * @returns {URLSearchParams}
 */
export function searchParams(plan, apiKey) {
  const { outbound, inbound } = plan.route;
  const p = { engine: 'google_flights', hl: 'en', currency: plan.currency, adults: '1' };

  if (outbound && inbound && outbound.to === inbound.from) {
    Object.assign(p, { type: '1', departure_id: outbound.from, arrival_id: outbound.to, outbound_date: outbound.date, return_date: inbound.date });
  } else if (outbound && inbound) {
    const legs = [outbound, inbound].map((l) => ({ departure_id: l.from, arrival_id: l.to, date: l.date }));
    Object.assign(p, { type: '3', multi_city_json: JSON.stringify(legs) });
  } else {
    const leg = outbound ?? inbound;
    Object.assign(p, { type: '2', departure_id: leg.from, arrival_id: leg.to, outbound_date: leg.date });
  }

  return new URLSearchParams({ ...p, api_key: apiKey });
}

/**
 * The response reduced to what the panel shows. Options are sorted by price, then by
 * departure time, so equal prices come out in a stable order.
 */
export function summarize(raw) {
  const googleFlightsUrl = raw?.search_metadata?.google_flights_url ?? null;
  if (raw?.error) {
    return /hasn't returned any results/i.test(raw.error)
      ? { reason: 'no-flights', message: 'No flights found for these dates', googleFlightsUrl }
      : { reason: 'search-error', message: raw.error };
  }

  const departs = (o) => o.flights?.[0]?.departure_airport?.time ?? '';
  const options = [...(raw.best_flights ?? []), ...(raw.other_flights ?? [])]
    .filter((o) => typeof o.price === 'number')
    .sort((a, b) => a.price - b.price || departs(a).localeCompare(departs(b)));
  if (options.length === 0) return { reason: 'no-flights', message: 'No flights found for these dates', googleFlightsUrl };

  return {
    fromPrice: options[0].price,
    options: options.slice(0, 3).map((o) => ({
      price: o.price,
      airlines: [...new Set(o.flights.map((f) => f.airline))].join(', '),
      departs: departs(o),
      stops: o.flights.length - 1,
      minutes: o.total_duration,
    })),
    googleFlightsUrl,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Capture a round-trip response and pin it — 1 live search**

```bash
node --env-file=.env --input-type=module -e '
import { planFlights, searchParams, summarize } from "./flights.js";
const seattle = { departurePort: "Seattle, Washington, US", endPort: "Seattle, Washington, US", departureDate: "2027-04-24", nights: 7, endDate: "2027-05-01", currency: "USD" };
const plan = planFlights(seattle, "YYZ", "2026-10-07");
const t0 = Date.now(); const r = await fetch("https://serpapi.com/search.json?" + searchParams(plan, process.env.SERP_API_KEY));
const body = await r.text(); (await import("node:fs")).writeFileSync("test/fixtures/serpapi-roundtrip.json", body);
console.log(Date.now() - t0, "ms"); console.log(JSON.stringify(summarize(JSON.parse(body)), null, 1));'
grep -c api_key test/fixtures/serpapi-roundtrip.json   # expect 0
```

Expected: a `fromPrice` and three options (YYZ → SEA round trip, 23 Apr – 1 May 2027). Add a test that holds whatever the market returned:

```js
const roundtrip = JSON.parse(await readFile(new URL('./fixtures/serpapi-roundtrip.json', import.meta.url), 'utf8'));

test('a round-trip response reduces the same way', () => {
  const s = summarize(roundtrip);
  const prices = [...(roundtrip.best_flights ?? []), ...(roundtrip.other_flights ?? [])].map((o) => o.price);
  assert.equal(s.fromPrice, Math.min(...prices));
  assert.equal(s.options.length, 3);
  assert.ok(s.options.every((o, i, all) => i === 0 || all[i - 1].price <= o.price));
});
```

- [ ] **Step 7: Run and commit**

Run: `npm test` — all pass.

```bash
git add flights.js test/flights.test.js test/fixtures/serpapi-multicity.json test/fixtures/serpapi-roundtrip.json
git commit -m "Plan a cruise's flights and read Google Flights results"
```

---

### Task 4: The cache, and `GET /api/flights`

**Files:**
- Modify: `flights.js` (`flightsFor`, cache helpers)
- Modify: `server.js` (route)
- Modify: `.gitignore` (`data/flights-cache.json`)
- Test: `test/flights.test.js`

**Interfaces:**
- Consumes: `planFlights`, `searchParams`, `summarize` (Task 3).
- Produces: `flightsFor(sailing, home, { today, apiKey, cacheFile, fetchImpl = fetch, now = Date.now() })` → `{ route, names, currency, fromPrice, options, googleFlightsUrl, fetchedAt, cached }` (`names`: airport code → city name, from `airportName`) or `{ reason, message, route?, googleFlightsUrl? }`. `GET /api/flights?id=<sailing id>&home=<IATA>` returns that as JSON.

- [ ] **Step 1: Write the failing tests**

Add `flightsFor` to the import in `test/flights.test.js`, add `import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';`, and append:

```js
// A fake fetch: counts calls, returns a saved response. Tests never reach SerpApi.
function fakeFetch(body) {
  const f = async () => { f.calls += 1; return { json: async () => body }; };
  f.calls = 0;
  return f;
}
const opts = async (fetchImpl, extra = {}) => ({
  today: TODAY, apiKey: 'test-key', fetchImpl,
  cacheFile: join(await mkdtemp(join(tmpdir(), 'flights-')), 'cache.json'), ...extra,
});

test('a search is cached: the second ask is free', async () => {
  const f = fakeFetch(multicity); const o = await opts(f);
  const first = await flightsFor(westerdam, 'YYZ', o);
  const second = await flightsFor(westerdam, 'YYZ', o);
  assert.equal(f.calls, 1);
  assert.equal(first.fromPrice, 517);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.fromPrice, 517);
  assert.deepEqual(first.names, { YYZ: 'Toronto', YVR: 'Vancouver', ANC: 'Anchorage' });
});

test('a cached result older than three days is searched again', async () => {
  const f = fakeFetch(multicity); const o = await opts(f);
  await flightsFor(westerdam, 'YYZ', { ...o, now: Date.parse('2026-10-07T12:00:00Z') });
  await flightsFor(westerdam, 'YYZ', { ...o, now: Date.parse('2026-10-10T11:00:00Z') });
  assert.equal(f.calls, 1, 'under three days: cached');
  await flightsFor(westerdam, 'YYZ', { ...o, now: Date.parse('2026-10-10T13:00:00Z') });
  assert.equal(f.calls, 2, 'over three days: searched again');
});

test('two asks for the same trip at once make one search', async () => {
  const f = fakeFetch(multicity); const o = await opts(f);
  await Promise.all([flightsFor(westerdam, 'YYZ', o), flightsFor(westerdam, 'YYZ', o)]);
  assert.equal(f.calls, 1);
});

test('an error is shown and not cached, so the next ask tries again', async () => {
  const f = fakeFetch({ error: 'Your account has run out of searches.' }); const o = await opts(f);
  const r = await flightsFor(westerdam, 'YYZ', o);
  assert.equal(r.reason, 'search-error');
  await flightsFor(westerdam, 'YYZ', o);
  assert.equal(f.calls, 2);
});

test('no key, or a refused plan, spends nothing', async () => {
  const f = fakeFetch(multicity);
  assert.equal((await flightsFor(westerdam, 'YYZ', await opts(f, { apiKey: undefined }))).reason, 'no-key');
  assert.equal((await flightsFor({ ...westerdam, endPort: 'Nowhere Bay' }, 'YYZ', await opts(f))).reason, 'no-airport');
  assert.equal(f.calls, 0);
});

test('a network failure becomes a message', async () => {
  const failing = async () => { throw new Error('ECONNRESET'); };
  const r = await flightsFor(westerdam, 'YYZ', await opts(failing));
  assert.equal(r.reason, 'search-error');
  assert.equal(r.message, "Couldn't reach the flight search");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/flights.test.js`
Expected: FAIL — `flightsFor` is not exported.

- [ ] **Step 3: Implement**

Add to the imports of `flights.js`:

```js
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
```

and change the airports import to `import { airportFor, airportName } from './airports.js';`.

Append to `flights.js`:

```js
const CACHE_DAYS = 3;
const TIMEOUT_MS = 30_000;
const ENDPOINT = 'https://serpapi.com/search.json';

/** Searches in progress, so two asks for one trip share a search. */
const inFlight = new Map();

const cacheKey = (plan) => {
  const { outbound: o, inbound: i } = plan.route;
  return [o?.from, o?.to, o?.date, i?.from, i?.to, i?.date, plan.currency].join('|');
};

async function readCache(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

/** Written as the sailings are: a temp file, then a rename, so a crash never leaves half a file. */
async function writeCache(file, cache) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

async function search(plan, { apiKey, fetchImpl }) {
  try {
    const res = await fetchImpl(`${ENDPOINT}?${searchParams(plan, apiKey)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return summarize(await res.json());
  } catch {
    return { reason: 'search-error', message: "Couldn't reach the flight search" };
  }
}

/**
 * Flights for a sailing, from the cache when it is fresh, otherwise one search.
 * Errors are never cached — the next ask tries again. "No flights found" is.
 */
export async function flightsFor(sailing, home, { today, apiKey, cacheFile, fetchImpl = fetch, now = Date.now() }) {
  const plan = planFlights(sailing, home, today);
  if (plan.reason) return plan;
  if (!apiKey) return { reason: 'no-key', message: "Flight search isn't set up: add SERP_API_KEY to .env" };

  // City names for the panel: "Toronto (YYZ) → Vancouver (YVR)".
  const legs = [plan.route.outbound, plan.route.inbound].filter(Boolean);
  const names = Object.fromEntries(legs.flatMap((l) => [l.from, l.to]).map((c) => [c, airportName(c)]));

  const key = cacheKey(plan);
  const cache = await readCache(cacheFile);
  const hit = cache[key];
  if (hit && now - Date.parse(hit.fetchedAt) < CACHE_DAYS * 86_400_000) {
    return { route: plan.route, names, currency: plan.currency, ...hit.result, fetchedAt: hit.fetchedAt, cached: true };
  }

  if (!inFlight.has(key)) {
    inFlight.set(key, (async () => {
      const result = await search(plan, { apiKey, fetchImpl });
      const fetchedAt = new Date(now).toISOString();
      if (result.reason !== 'search-error') {
        const latest = await readCache(cacheFile);
        latest[key] = { fetchedAt, result };
        await writeCache(cacheFile, latest);
      }
      return { result, fetchedAt };
    })().finally(() => inFlight.delete(key)));
  }

  const { result, fetchedAt } = await inFlight.get(key);
  return { route: plan.route, names, currency: plan.currency, ...result, fetchedAt, cached: false };
}
```

In `server.js`, add to the imports `import { flightsFor } from './flights.js';`, add near `DATA_FILE`:

```js
const FLIGHTS_CACHE = new URL('./data/flights-cache.json', import.meta.url).pathname;
```

and add this route directly before the `/search.js` route:

```js
    if (req.method === 'GET' && req.url.startsWith('/api/flights?')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const home = (params.get('home') ?? '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(home)) {
        return json(res, 400, { reason: 'bad-home', message: 'Use a three-letter airport code, like YYZ.' });
      }
      dataset = await loadDataset();
      const sailing = dataset?.sailings.find((s) => s.id === params.get('id'));
      if (!sailing) return json(res, 404, { reason: 'not-found', message: 'No such sailing.' });
      return json(res, 200, await flightsFor(sailing, home, {
        today: localDate(), apiKey: process.env.SERP_API_KEY, cacheFile: FLIGHTS_CACHE,
      }));
    }
```

In `.gitignore`, after `data/debug/`, add `data/flights-cache.json` and `data/flights-cache.json.tmp`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Check the route without spending a search**

The server is started **without** `.env`, so it has no key and cannot search:

```bash
PORT=3031 node server.js > /dev/null 2>&1 & SRV=$!; sleep 1
curl -s 'http://localhost:3031/api/flights?id=holland-america:W728_cruise&home=yyz'; echo
curl -s 'http://localhost:3031/api/flights?id=holland-america:W728_cruise&home=TORONTO'; echo
curl -s 'http://localhost:3031/api/flights?id=nope&home=YYZ'; echo
kill $SRV
```

Expected: `{"reason":"no-key",…}` (lower-case `yyz` accepted), `{"reason":"bad-home",…}`, `{"reason":"not-found",…}`. `git check-ignore data/flights-cache.json` prints the path.

- [ ] **Step 6: Commit**

```bash
git add flights.js server.js .gitignore test/flights.test.js
git commit -m "Cache flight searches and serve them at /api/flights"
```

---

### Task 5: The panel

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /api/flights` (Task 4), including `names` for showing "Toronto (YYZ) → Vancouver (YVR)".
- Consumes from earlier work: `shownPrice`, `cabinName`, `money`, `prettyDate`, `el`, `safeUrl`.

No unit harness covers the page; Step 3 checks it in a headless browser without spending a search.

- [ ] **Step 1: Styles and containers**

In the `<style>` block, after the `a.book:hover` rule:

```css
  .flights-btn { background: none; border: 1px solid var(--line); border-radius: 999px;
    padding: 4px 10px; font: inherit; font-size: 13px; font-weight: 600; color: var(--accent); cursor: pointer; }
  .panel-backdrop { position: fixed; inset: 0; background: rgba(6,20,28,.35); z-index: 20; }
  .panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); background: var(--panel);
    box-shadow: var(--shadow); padding: 20px; overflow-y: auto; z-index: 21;
    display: flex; flex-direction: column; gap: 12px; }
  .panel[hidden], .panel-backdrop[hidden] { display: none; }
  .panel .close { align-self: flex-end; background: none; border: 0; font-size: 20px; cursor: pointer; color: var(--muted); }
  .panel h2 { margin: 0; font-size: 18px; }
  .panel input { width: 4.5em; text-transform: uppercase; font: inherit; padding: 4px 6px; }
  .leg { font-size: 14px; }
  .option { font-size: 13px; color: var(--muted); }
```

After `<div id="results" class="grid"></div>`:

```html
  <div id="panel-backdrop" class="panel-backdrop" hidden></div>
  <aside id="panel" class="panel" hidden aria-label="Flights"></aside>
```

- [ ] **Step 2: The panel's script**

After the `shownPrice` helper:

```js
const HOME_KEY = 'ai-cruises.home';
const readHome = () => { try { return localStorage.getItem(HOME_KEY) || 'YYZ'; } catch { return 'YYZ'; } };
const saveHome = (code) => { try { localStorage.setItem(HOME_KEY, code); } catch { /* private mode: not remembered */ } };
const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const hm = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
const checkedAgo = (iso) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? 'checked today' : `checked ${days} day${days === 1 ? '' : 's'} ago`;
};

let panelSailing = null;

function closePanel() {
  $('#panel').hidden = true;
  $('#panel-backdrop').hidden = true;
  panelSailing = null;
}

function openPanel(s) {
  panelSailing = s;
  const panel = $('#panel');
  panel.textContent = '';
  const home = el('input', { value: readHome(), maxlength: '3', 'aria-label': 'Home airport code' });
  const body = el('div', {});
  const close = el('button', { class: 'close', type: 'button', 'aria-label': 'Close', text: '✕' });
  close.onclick = closePanel;
  panel.append(close,
    el('h2', { text: s.itinerary ?? titleCase(s.destination ?? 'Cruise') }),
    el('div', { class: 'meta', text: `${s.ship} · ${prettyDate(s.departureDate)} · ${s.nights} nights` }),
    el('label', { class: 'meta' }, 'Flying from: ', home),
    body);
  home.onchange = () => {
    const code = home.value.trim().toUpperCase();
    home.value = code;
    if (!/^[A-Z]{3}$/.test(code)) { body.textContent = 'Use a three-letter airport code, like YYZ.'; return; }
    saveHome(code);
    showFlights(s, code, body);
  };
  panel.hidden = false;
  $('#panel-backdrop').hidden = false;
  close.focus();
  showFlights(s, home.value, body);
}

async function showFlights(s, home, body) {
  body.textContent = '';
  body.append(el('p', { class: 'meta', text: 'Searching flights… (about 10 seconds)' }));
  let data;
  try {
    const res = await fetch(`/api/flights?id=${encodeURIComponent(s.id)}&home=${encodeURIComponent(home)}`);
    data = await res.json();
  } catch {
    data = { message: "Couldn't reach the flight search" };
  }
  if (panelSailing !== s) return; // closed, or another cruise opened meanwhile
  body.textContent = '';

  const { outbound, inbound } = data.route ?? {};
  const place = (code) => (data.names?.[code] ? `${data.names[code]} (${code})` : code);
  for (const leg of [outbound, inbound].filter(Boolean)) {
    body.append(el('div', { class: 'leg', text: `${place(leg.from)} → ${place(leg.to)} · ${shortDate(leg.date)}` }));
  }

  const link = safeUrl(data.googleFlightsUrl);
  const googleLink = link ? el('a', { class: 'book', href: link, target: '_blank', rel: 'noopener', text: 'See all on Google Flights ↗' }) : null;

  if (data.fromPrice == null) {
    body.append(el('p', { text: data.message ?? 'No flights found.' }), googleLink);
    return;
  }

  const shown = shownPrice(s);
  const cruisePrice = shown.notListed ? s.price : shown.price;
  body.append(
    el('div', { class: 'price', text: `Flights from about ${money(data.fromPrice)}` }),
    el('div', { class: 'meta', text: `Cruise + flights from about ${money(cruisePrice + data.fromPrice)}`
      + (shown.notListed ? ` (cruise at its cheapest, ${cabinName(s.cabin).toLowerCase()} — the ${cabinName(shown.cabin).toLowerCase()} price isn't listed)` : '') }),
    ...data.options.map((o) => el('div', { class: 'option',
      text: `${money(o.price)} · ${o.airlines} · ${o.departs.slice(11)} · ${o.stops === 0 ? 'nonstop' : `${o.stops} stop${o.stops === 1 ? '' : 's'}`} · ${hm(o.minutes)}` })),
    el('div', { class: 'meta', text: 'Prices are for the whole trip, per person; times are for the flight out.' }),
    googleLink,
    el('div', { class: 'meta', text: checkedAgo(data.fetchedAt) }));
}

$('#panel-backdrop').onclick = closePanel;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelSailing) closePanel(); });
```

In `render`, replace the `foot`'s link argument:

```js
      link ? el('a', { class: 'book', href: link, target: '_blank', rel: 'noopener', text: 'View ↗' }) : null);
```

with:

```js
      el('div', {}, flightsButton(s), link ? el('a', { class: 'book', href: link, target: '_blank', rel: 'noopener', text: ' View ↗' }) : null));
```

and add before `render`:

```js
function flightsButton(s) {
  const b = el('button', { class: 'flights-btn', type: 'button', text: '✈ Flights' });
  b.onclick = () => openPanel(s);
  return b;
}
```

- [ ] **Step 3: Check it in a headless browser — no search spent**

The server runs **without** `.env`, so the panel's search returns "isn't set up":

```bash
PORT=3031 node server.js > /dev/null 2>&1 & SRV=$!; sleep 1
cat > check-panel.tmp.mjs <<'EOF'
import { launch } from './browser.js';
const b = await launch(); const p = await b.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.setViewport({ width: 800, height: 600 });
await p.goto('http://localhost:3031/', { waitUntil: 'networkidle0' });
await p.click('.yearchip');
await p.click('.flights-btn');
await p.waitForFunction(() => !document.querySelector('#panel').hidden && !/Searching/.test(document.querySelector('#panel').textContent));
console.log('panel:', await p.$eval('#panel', (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 300)));
await p.screenshot({ path: process.env.TMPDIR + '/panel-800.png' });
await p.keyboard.press('Escape');
console.log('closed by Esc:', await p.$eval('#panel', (e) => e.hidden));
console.log('page errors:', errors.length ? errors : 'none');
await b.close();
EOF
node check-panel.tmp.mjs; rm check-panel.tmp.mjs; kill $SRV
```

Expected: the panel text includes the cruise's title, "Flying from:", and "Flight search isn't set up: add SERP_API_KEY to .env"; `closed by Esc: true`; no page errors. Look at `$TMPDIR/panel-800.png`: the panel overlays the right side and fits.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Add a flights panel to each cruise card"
```

---

### Task 6: Scrape, live checks, and the record

**Files:**
- Modify: `airports.js` and `test/airports.test.js` (any ports the scrape reports)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full scrape**

```bash
node scrape.js; echo "exit: $?"
```

Expected: exit 0. In `unrecognised`, any `airport` entries are ports the table lacks.

- [ ] **Step 2: Add the reported ports**

For each `airport: "<port>"` entry, add its name to the right airport in `airports.js` (looking up the city if unsure — the port's own text usually names it, e.g. "(for Rome)"), add the port to `PORTS` in `test/airports.test.js`, run `npm test`, then re-run `node scrape.js` until no `airport` entries remain. Commit:

```bash
git add airports.js test/airports.test.js
git commit -m "Add the airports for ports found in the scrape"
```

- [ ] **Step 3: Check Princess one-way end ports against the site**

```bash
node -e 'const s=require("./data/sailings.json").sailings.filter(x=>x.line.startsWith("Princess") && x.endPort!==x.departurePort).slice(0,3); s.forEach(x=>console.log(x.itinerary,"|",x.departurePort,"->",x.endPort,"|",x.url))'
```

Open each URL. Expected: the site's itinerary ends at the printed `endPort`. If a card's port list is shortened and the end port is wrong, stop and record it — the fix (reading the detail page, or the itinerary title) is a separate decision.

- [ ] **Step 4: Live check — Peter does this; 1 search**

Restart the server (`Ctrl-C`, `npm run serve`). Open the **Westerdam · 7-Day Glacier Discovery Northbound · 9 May 2027** card's **✈ Flights**. Expected:

- First open: "Searching flights…" for ~10 seconds, then the legs *Toronto (YYZ) → Vancouver (YVR) · Sat, May 8* and *Anchorage (ANC) → Toronto (YYZ) · Sun, May 16*, "Flights from about $5xx", a cruise + flights total, three options, the Google Flights link, "checked today".
- Close and reopen: instant, same result (cached — no search spent).
- Change "Flying from" to **YVR**: only the Anchorage → Vancouver leg is searched.

- [ ] **Step 5: Update `CLAUDE.md`**

- Environment: `SERP_API_KEY` in `.env`; SerpApi free plan, 250 searches/month; the cache file.
- Status: a **Flights panel** paragraph — what it shows, `airports.js` and that the scrape reports unknown ports as `airport` entries, `flights.js` and the cache (3 days), the 330-day limit, and the spike's finding that a first-leg price is the whole trip's price.
- The test count from `npm test`.

```bash
git add CLAUDE.md
git commit -m "Record the flights panel in the project notes"
```
