# Prices per Cabin Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cabin search finds sailings that offer that cabin, priced for that cabin — "a week in Alaska with a balcony under $2,000" compares balcony prices.

**Architecture:** Each sailing gains `cabinPrices` (canonical cabin type → cheapest price), built by `normalize.js` from a raw label→price table each adapter supplies; `null` means "not listed" (Princess). One function, `priceFor(sailing, cabin)` in `search.js`, decides which price counts and whether a sailing qualifies. The server uses it in `searchSailings`; the page imports the same file, so the dropdown, slider, sort and cards follow the same rule.

**Tech Stack:** Node 22 (ESM), `node --test`, plain browser ES modules. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-cabin-prices-design.md` — read it first.

## Global Constraints

- Node 22, ESM. Dependencies stay `puppeteer` and `@anthropic-ai/sdk`. No new packages.
- Canonical cabin types are exactly `interior`, `oceanview`, `balcony`, `suite` — the existing `CABINS` keys in `normalize.js`.
- `price` and `cabin` keep meaning the sailing's cheapest overall. Nothing that reads them changes meaning.
- `cabinPrices`: an object of canonical type → number; a type with no price is absent. `null` = not listed. `undefined` occurs only in data scraped before this change.
- Searches that mention no cabin behave exactly as before.
- Adapters stay standalone files; no shared adapter code.
- Synthetic test data inline in tests; fixtures are real captures.
- The project has a GitHub remote. Commit; never push — Peter pushes.

## Review Focus

1. **A Princess sailing searched for the cabin it *does* list** ("interior"). Expected: its real interior price, not "not listed". The spec's table said any `null` table is not listed; that would hide a price we know. Corrected in this plan (Task 1) and in the spec. → Task 1.
2. **A cabin search with a price limit, where the cheapest cabin is under the limit but the asked-for cabin is over it.** Expected: excluded — the limit applies to the asked-for cabin. → Task 4.
3. **A table whose every class was unpriced** (`{}`). Expected: any cabin search excludes it; a search with no cabin still uses its cheapest price. → Task 1.
4. **Data scraped before this change** (no `cabinPrices`) while the server already runs the new code. Expected: cabin search and the dropdown behave as they did before. → Tasks 1 and 4.
5. **An unmappable cabin label in a table** (Holland America's Lanai). Expected: reported in `unrecognised`, the other cabins kept, the sailing kept. → Task 2.

---

### Task 1: `priceFor`, and serving `search.js` to the page

**Files:**
- Modify: `search.js` (new export `priceFor`)
- Modify: `server.js` (`PORT` from the environment; a `/search.js` route)
- Modify: `docs/superpowers/specs/2026-10-03-cabin-prices-design.md` (Review Focus 1 correction)
- Test: `test/search.test.js`

**Interfaces:**
- Produces: `priceFor(sailing: object, cabin: string|null|undefined): { price: number|null, cabin: string|null, notListed?: true } | null`. `GET /search.js` returns `search.js` as `text/javascript`. `PORT` env var, default 3030.

- [ ] **Step 1: Write the failing tests**

Add `priceFor,` to the import list at the top of `test/search.test.js`, then append:

```js
// Which price counts for a sailing when a cabin is asked for. One rule, used by the
// server's search and by the page (which imports this same file).
const withTable = { cabin: 'interior', price: 959, cabinPrices: { interior: 959, oceanview: 1009, balcony: 1459 } };
const notListed = { cabin: 'interior', price: 1142, cabinPrices: null }; // Princess
const oldData = { cabin: 'interior', price: 959 }; // scraped before cabinPrices existed

test('priceFor: no cabin asked for means the cheapest, as before', () => {
  assert.deepEqual(priceFor(withTable, null), { price: 959, cabin: 'interior' });
  assert.deepEqual(priceFor(withTable, undefined), { price: 959, cabin: 'interior' });
});

test('priceFor: a cabin in the table is priced from the table', () => {
  assert.deepEqual(priceFor(withTable, 'balcony'), { price: 1459, cabin: 'balcony' });
});

test('priceFor: a cabin missing from the table excludes the sailing', () => {
  assert.equal(priceFor(withTable, 'suite'), null);
  assert.equal(priceFor({ cabin: 'interior', price: 959, cabinPrices: {} }, 'interior'), null);
});

test('priceFor: a not-listed table is included, without a price', () => {
  assert.deepEqual(priceFor(notListed, 'balcony'), { price: null, cabin: 'balcony', notListed: true });
});

test('priceFor: a not-listed table still prices the one cabin it does list', () => {
  assert.deepEqual(priceFor(notListed, 'interior'), { price: 1142, cabin: 'interior' });
});

test('priceFor: data without a table falls back to the cheapest-cabin rule', () => {
  assert.deepEqual(priceFor(oldData, 'interior'), { price: 959, cabin: 'interior' });
  assert.equal(priceFor(oldData, 'balcony'), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/search.test.js`
Expected: FAIL — `does not provide an export named 'priceFor'`.

- [ ] **Step 3: Implement `priceFor`**

Add to `search.js`, after `searchSailings`:

```js
/**
 * Which price counts for this sailing when a cabin is asked for — and whether the
 * sailing qualifies at all. One rule, used by searchSailings and by the page.
 *
 * - No cabin asked for: the cheapest price, as it has always been.
 * - The sailing's cabinPrices table has the cabin: that cabin's price.
 * - A table without the cabin: null — the sailing does not offer it.
 * - cabinPrices null (only the cheapest cabin is listed — Princess): the listed
 *   cabin's price if that is the one asked for, otherwise "not listed".
 * - cabinPrices undefined (data scraped before the table existed): the old rule,
 *   matching on the cheapest cabin.
 *
 * @param {object} sailing
 * @param {string|null|undefined} cabin
 * @returns {{price: number|null, cabin: string|null, notListed?: true}|null}
 */
export function priceFor(sailing, cabin) {
  if (!cabin) return { price: sailing.price, cabin: sailing.cabin };

  const table = sailing.cabinPrices;
  if (table === undefined || table === null) {
    if (sailing.cabin === cabin) return { price: sailing.price, cabin };
    return table === null ? { price: null, cabin, notListed: true } : null;
  }

  return table[cabin] !== undefined ? { price: table[cabin], cabin } : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Serve `search.js` to the page**

In `server.js`, change the port line:

```js
// PORT lets a second copy run beside the usual one, e.g. to check a change.
const PORT = Number(process.env.PORT) || 3030;
```

Add this route directly before the `// Static assets from public/` block:

```js
    // The page imports the same filter rules the server uses (priceFor), so the
    // dropdown and the search can never disagree. search.js has no imports.
    if (req.method === 'GET' && req.url === '/search.js') {
      const js = await readFile(new URL('./search.js', import.meta.url));
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(js);
    }
```

- [ ] **Step 6: Check the route on a second server**

```bash
PORT=3031 node --env-file-if-exists=.env server.js & SRV=$!; sleep 1
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:3031/search.js
curl -s http://localhost:3031/search.js | grep -c 'export function priceFor'
kill $SRV
```

Expected: `200 text/javascript; charset=utf-8`, then `1`.

- [ ] **Step 7: Correct the spec**

In `docs/superpowers/specs/2026-10-03-cabin-prices-design.md`, section 2's table, replace the Princess row with:

```markdown
| `cabinPrices` is `null` (Princess) | the asked-for cabin is the sailing's `cabin`: `{ price: sailing.price, cabin }`; otherwise `{ price: null, cabin, notListed: true }` — included |
```

- [ ] **Step 8: Commit**

```bash
git add search.js server.js test/search.test.js docs/superpowers/specs/2026-10-03-cabin-prices-design.md
git commit -m "Add priceFor, and serve search.js so the page can share it"
```

---

### Task 2: `cabinPrices` in normalize and values

**Files:**
- Modify: `normalize.js` (`normalizeAll`, new helper `canonicalCabinPrices`)
- Modify: `values.js` (`cabin` list)
- Test: `test/normalize.test.js`, `test/values.test.js`

**Interfaces:**
- Consumes: raw `row.cabinPrices` from adapters: `{ [siteLabel]: number }`, or absent.
- Produces: every normalized sailing has `cabinPrices: { [canonicalCabin]: number } | null`. `deriveValues(...).cabin` includes every key of every table.

- [ ] **Step 1: Write the failing tests**

In `test/normalize.test.js`, the test `'a good row becomes a fully canonical Sailing'` compares the whole object: add `cabinPrices: null,` directly after `price: 1299,`.

Append:

```js
test('cabinPrices: site labels become cabin types, the cheaper price kept per type', () => {
  const row = { ...goodRow, cabinPrices: { INTERIOR: 949.94, OUTSIDE: 999.94, BALCONY: 999.94, CONCIERGE: 1199.94 } };
  const { sailings, unrecognised } = normalizeAll([row], { source: 'celebrity', line: 'Celebrity Cruises' });
  assert.deepEqual(sailings[0].cabinPrices, { interior: 949.94, oceanview: 999.94, balcony: 999.94 });
  assert.equal(unrecognised.length, 0);
});

test('cabinPrices: an unmappable label is reported, and the rest kept', () => {
  const row = { ...goodRow, cabinPrices: { Inside: 959, Lanai: 1300, Verandah: 1459 } };
  const { sailings, unrecognised } = normalizeAll([row], { source: 'holland-america', line: 'Holland America' });
  assert.equal(sailings.length, 1);
  assert.deepEqual(sailings[0].cabinPrices, { interior: 959, balcony: 1459 });
  assert.deepEqual(unrecognised, [{ field: 'cabin', raw: 'Lanai', count: 1 }]);
});

test('cabinPrices: an adapter that supplies none is "not listed"', () => {
  const { sailings } = normalizeAll([goodRow], { source: 'princess', line: 'Princess' });
  assert.equal(sailings[0].cabinPrices, null);
});
```

In `test/values.test.js`, append:

```js
test('cabin includes types found only in a cabinPrices table', () => {
  const values = deriveValues([
    { ...sailings[1], cabin: 'interior', cabinPrices: { interior: 900, balcony: 1400 } },
    { ...sailings[2], cabin: 'interior', cabinPrices: null },
  ]);
  assert.deepEqual(values.cabin, ['balcony', 'interior']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/normalize.test.js test/values.test.js`
Expected: FAIL — the canonical-Sailing test lacks `cabinPrices`; the new tests get `undefined` or miss `balcony`.

- [ ] **Step 3: Implement**

In `normalize.js`, add after `canonicalCabin`:

```js
/**
 * A site's per-cabin prices ({ BALCONY: 1028.16, … }) as cabin types. Two labels
 * that are one type (Celebrity's Balcony and Concierge) keep the cheaper price. An
 * adapter that supplies no table gets null: only the cheapest cabin is listed.
 *
 * @param {object|undefined|null} raw
 * @param {(field: string, raw: string) => void} miss
 * @returns {object|null}
 */
function canonicalCabinPrices(raw, miss) {
  if (raw === undefined || raw === null) return null;
  const table = {};
  for (const [label, value] of Object.entries(raw)) {
    const price = toNumber(value);
    if (price === null) continue;
    const cabin = canonicalCabin(label);
    if (cabin === null) {
      miss('cabin', String(label));
      continue;
    }
    if (table[cabin] === undefined || price < table[cabin]) table[cabin] = price;
  }
  return table;
}
```

In `normalizeAll`, add to the `sailing` object directly after `price: toNumber(row.price),`:

```js
      cabinPrices: null,
```

And directly after the `if (row.cabin) { … }` block:

```js
    sailing.cabinPrices = canonicalCabinPrices(row.cabinPrices, miss);
```

In `values.js`, replace the `cabin:` line with:

```js
    // Every cabin type on offer, not just each sailing's cheapest — so "balcony" is
    // a choice whenever any sailing prices one.
    cabin: uniqueSortedStrings([
      ...sailings.map((s) => s.cabin),
      ...sailings.flatMap((s) => Object.keys(s.cabinPrices ?? {})),
    ]),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add normalize.js values.js test/normalize.test.js test/values.test.js
git commit -m "Normalize per-cabin price tables into cabin types"
```

---

### Task 3: Each adapter supplies its table

**Files:**
- Modify: `sites/royal-caribbean.js`, `sites/celebrity.js`, `sites/holland-america.js`
- Modify: `test/fixtures/royal-caribbean-first-row.json`, `test/fixtures/celebrity-first-row.json`, `test/fixtures/holland-america-first-row.json`
- Test: `test/royal-caribbean.test.js`, `test/celebrity.test.js`, `test/holland-america.test.js`, `test/princess.test.js`

**Interfaces:**
- Consumes: `normalizeAll` (Task 2).
- Produces: raw rows with `cabinPrices: { [siteLabel]: number }` (Royal Caribbean, Celebrity, Holland America); Princess rows without it.

Expected tables, measured from each fixture's first sailing on 2026-10-03:

| Fixture | Raw `cabinPrices` | Normalized |
|---|---|---|
| Royal Caribbean, WN4BH349 | `{ INTERIOR: 598.16, BALCONY: 1028.16 }` | `{ interior: 598.16, balcony: 1028.16 }` |
| Celebrity, BY07W680 | `{ INTERIOR: 949.94, OUTSIDE: 999.94, BALCONY: 999.94, CONCIERGE: 1199.94 }` | `{ interior: 949.94, oceanview: 999.94, balcony: 999.94 }` |
| Holland America USD, D733 | `{ Inside: 959, 'Ocean View': 1009, Verandah: 1459, 'Signature Suite': 2164, 'Neptune Suite': 3024 }` | `{ interior: 959, oceanview: 1009, balcony: 1459, suite: 2164 }` |
| Holland America CAD, W656 | `{ Inside: 1124 }` | `{ interior: 1124 }` |

- [ ] **Step 1: Write the failing tests**

Add the raw table to each golden first-row file, directly after its `"currency"` line:

- `test/fixtures/royal-caribbean-first-row.json`: `"cabinPrices": { "INTERIOR": 598.16, "BALCONY": 1028.16 },`
- `test/fixtures/celebrity-first-row.json`: `"cabinPrices": { "INTERIOR": 949.94, "OUTSIDE": 999.94, "BALCONY": 999.94, "CONCIERGE": 1199.94 },`
- `test/fixtures/holland-america-first-row.json`: `"cabinPrices": { "Inside": 959, "Ocean View": 1009, "Verandah": 1459, "Signature Suite": 2164, "Neptune Suite": 3024 },`

In `test/holland-america.test.js`, the test `'the first row reads as the captured sailing'` has an inline expected object: add `cabinPrices: { Inside: 1124 },` after `currency: 'CAD',`.

Append to `test/royal-caribbean.test.js`:

```js
test('the cabin table normalizes to cabin types, without unpriced classes', () => {
  const { sailings } = normalizeAll(parseListing(payload), { source: 'royal-caribbean', line: 'Royal Caribbean' });
  assert.deepEqual(sailings[0].cabinPrices, { interior: 598.16, balcony: 1028.16 });
  assert.ok(sailings.every((s) => s.cabinPrices && s.cabinPrices[s.cabin] === s.price));
});
```

Append to `test/celebrity.test.js` (add `import { normalizeAll } from '../normalize.js';` if the file lacks it, and use the file's existing payload variable name):

```js
test('the cabin table folds Concierge into balcony, keeping the cheaper price', () => {
  const { sailings } = normalizeAll(parseListing(payload), { source: 'celebrity', line: 'Celebrity Cruises' });
  assert.deepEqual(sailings[0].cabinPrices, { interior: 949.94, oceanview: 999.94, balcony: 999.94 });
  assert.ok(sailings.every((s) => s.cabinPrices && s.cabinPrices[s.cabin] === s.price));
});
```

Append to `test/holland-america.test.js`:

```js
test('the cabin table folds the suites into one suite price', () => {
  const { sailings } = normalizeAll(parseListing(usPayload), { source: 'holland-america', line: 'Holland America' });
  assert.deepEqual(sailings[0].cabinPrices, { interior: 959, oceanview: 1009, balcony: 1459, suite: 2164 });
  assert.ok(sailings.every((s) => s.cabinPrices && s.cabinPrices[s.cabin] === s.price));
});
```

Append to `test/princess.test.js` (add the `normalizeAll` import if missing; use the file's HTML variable):

```js
test('Princess lists only its cheapest cabin, so its table is "not listed"', () => {
  const { sailings } = normalizeAll(parseListing(html), { source: 'princess', line: 'Princess Cruises' });
  assert.ok(sailings.length > 0);
  assert.ok(sailings.every((s) => s.cabinPrices === null));
});
```

The `every(...)` assertions pin an invariant the search relies on: the cheapest cabin is always in its own table.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL in the three golden-row tests, the HAL inline first-row test, and the three new table tests (`cabinPrices` missing). The Princess test passes already — Princess needs no change; it pins that it stays `null`.

- [ ] **Step 3: Implement Royal Caribbean and Celebrity**

In both `sites/royal-caribbean.js` and `sites/celebrity.js`, after the `const cheapest = …` line:

```js
      // Every priced class, by the site's label; normalize.js maps them to cabin types.
      const cabinPrices = Object.fromEntries(
        priced.map((p) => [p.stateroomClass.id, p.price.value]),
      );
```

And add `cabinPrices,` to the pushed row directly after `currency: cheapest.price.currency.code,`.

- [ ] **Step 4: Implement Holland America**

In `sites/holland-america.js`, add after `cheapestFare`:

```js
/**
 * The cheapest public fare for each cabin code, in one currency — the one
 * cheapestFare chose, so the table and the headline price never mix currencies.
 *
 * @param {object} doc
 * @param {string} currency
 * @returns {object} cabin code -> price
 */
export function cabinFares(doc, currency) {
  const fares = {};
  for (const [key, value] of Object.entries(doc)) {
    const match = key.match(PUBLIC_FARE);
    if (!match || match[1] !== currency || typeof value !== 'number' || value <= 0) continue;
    const cabinCode = match[2];
    if (fares[cabinCode] === undefined || value < fares[cabinCode]) fares[cabinCode] = value;
  }
  return fares;
}
```

In `parseListing`, after `const labels = cabinLabels(doc.meta);`:

```js
    // Keyed by the site's cabin names, which normalize.js maps to cabin types.
    const cabinPrices = fare
      ? Object.fromEntries(
          Object.entries(cabinFares(doc, fare.currency))
            .map(([code, price]) => [labels[code] ?? code, price]),
        )
      : undefined;
```

And add `cabinPrices,` to the pushed row directly after `currency: fare?.currency ?? null,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add sites/royal-caribbean.js sites/celebrity.js sites/holland-america.js test/royal-caribbean.test.js test/celebrity.test.js test/holland-america.test.js test/princess.test.js test/fixtures/royal-caribbean-first-row.json test/fixtures/celebrity-first-row.json test/fixtures/holland-america-first-row.json
git commit -m "Supply per-cabin prices from Royal Caribbean, Celebrity and Holland America"
```

---

### Task 4: Search uses `priceFor`

**Files:**
- Modify: `search.js` (`searchSailings`)
- Test: `test/search.test.js`

**Interfaces:**
- Consumes: `priceFor` (Task 1).
- Produces: `searchSailings(sailings, filter)` — cabin filter via `priceFor`; `minPrice`/`maxPrice` against the `priceFor` price; a `notListed` result passes any price limit.

- [ ] **Step 1: Write the failing tests**

Append to `test/search.test.js`:

```js
const cabinSailings = [
  { cabin: 'interior', price: 959, cabinPrices: { interior: 959, balcony: 1459 } },
  { cabin: 'interior', price: 900, cabinPrices: { interior: 900, balcony: 2400 } },
  { cabin: 'interior', price: 1142, cabinPrices: null }, // Princess: not listed
  { cabin: 'interior', price: 700, cabinPrices: { interior: 700 } }, // no balcony
];

test('a cabin search finds sailings that offer it, not just those where it is cheapest', () => {
  assert.equal(searchSailings(cabinSailings, { cabin: 'balcony' }).length, 3);
});

test('a price limit applies to the asked-for cabin, not the cheapest one', () => {
  const found = searchSailings(cabinSailings, { cabin: 'balcony', maxPrice: 2000 });
  // 1459 balcony: in. 2400 balcony (cheapest 900): out. Not listed: in. No balcony: out.
  assert.deepEqual(found.map((s) => s.price), [959, 1142]);
});

test('without a cabin, price limits still use the cheapest price', () => {
  assert.equal(searchSailings(cabinSailings, { maxPrice: 950 }).length, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/search.test.js`
Expected: FAIL — the cabin search finds 0 (all cheapest cabins are interior); the price-limit test finds the wrong set.

- [ ] **Step 3: Implement**

In `searchSailings`, delete the line `if (filter.cabin && s.cabin !== filter.cabin) return false;` and the two lines testing `filter.minPrice` / `filter.maxPrice` against `s.price`. Insert, where the cabin line was:

```js
    // The cabin filter means "offers this cabin", and a price limit then applies to
    // that cabin's price. A not-listed price (Princess) passes: unknown, not too high.
    const counted = priceFor(s, filter.cabin);
    if (counted === null) return false;
    if (!counted.notListed) {
      if (filter.minPrice != null && counted.price < filter.minPrice) return false;
      if (filter.maxPrice != null && counted.price > filter.maxPrice) return false;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass — including every older search test, since no-cabin searches are unchanged.

- [ ] **Step 5: Commit**

```bash
git add search.js test/search.test.js
git commit -m "Search a cabin by whether it is offered, at its own price"
```

---

### Task 5: The page

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /search.js` exporting `priceFor` (Task 1); `sailing.cabinPrices` (Tasks 2–3); `data.filter.cabin` from `/api/search`.

No unit harness covers the page; Step 3 checks it in a headless browser.

- [ ] **Step 1: Share the rule, and choose the cabin**

At the top of the `<script type="module">`, before `const $ = …`:

```js
import { priceFor } from '/search.js';
```

Change the `state` line to include the search's cabin:

```js
const state = { all: [], subset: null, message: null, values: {}, facets: {}, searchCabin: null };
```

After the `titleCase` helper, add:

```js
const CABIN_NAMES = { interior: 'Interior', oceanview: 'Ocean view', balcony: 'Balcony', suite: 'Suite' };
const cabinName = (c) => CABIN_NAMES[c] ?? titleCase(c ?? 'cabin');

/** The dropdown wins over the search: it is the more recent, more specific choice. */
const chosenCabin = () => state.facets.cabin || state.searchCabin || null;

/** The price a card shows and the slider and sort use — the shared rule. */
const shownPrice = (s) => priceFor(s, chosenCabin()) ?? priceFor(s, null);
```

In the search handler, next to `state.subset = data.results;`:

```js
    state.searchCabin = data.filter.cabin ?? null;
```

- [ ] **Step 2: Filter, sort and render with it**

In `applyFacets`, replace `(!f.cabin || s.cabin === f.cabin) &&` with:

```js
    (!f.cabin || priceFor(s, f.cabin) !== null) &&
```

and replace `(f.maxPrice == null || s.price <= f.maxPrice));` with:

```js
    (f.maxPrice == null || shownPrice(s).notListed || shownPrice(s).price <= f.maxPrice));
```

In the sort, replace `: a.price - b.price);` with:

```js
    : (shownPrice(a).price ?? Infinity) - (shownPrice(b).price ?? Infinity));
```

(Not-listed prices sort last: they are unknown, so they cannot be "cheapest first".)

In `render`, replace the two lines that build `price` and the `foot`'s cabin `div` — from `const price = el('div', { class: 'price', text: money(s.price) });` through `el('div', {}, price, el('div', { class: 'cabin', text: s.cabin ?? 'cabin varies' })),` — with:

```js
    const shown = shownPrice(s);
    const price = shown.notListed
      ? el('div', { class: 'cabin', text: `${cabinName(shown.cabin)} price not listed · from ${money(s.price)} ${cabinName(s.cabin).toLowerCase()}` })
      : el('div', { class: 'price', text: money(shown.price) }, el('small', { text: ' pp' }));
    const priceLabel = shown.notListed ? null : el('div', { class: 'cabin', text: cabinName(shown.cabin) });

    // Every cabin's price, cheapest type first — useful whatever was searched for.
    const table = s.cabinPrices ? Object.keys(CABIN_NAMES).filter((c) => s.cabinPrices[c] !== undefined) : [];
    const cabinRow = table.length > 1
      ? el('div', { class: 'ports cabins', text: table.map((c) => `${cabinName(c)} ${money(s.cabinPrices[c])}`).join(' · ') })
      : null;
```

with the `foot` built from them:

```js
    const link = safeUrl(s.url);
    const foot = el('div', { class: 'foot' },
      el('div', {}, price, priceLabel),
      link ? el('a', { class: 'book', href: link, target: '_blank', rel: 'noopener', text: 'View ↗' }) : null);
```

and add `cabinRow,` to the card body directly after the `ports` line. Delete the old `price.append(el('small', { text: ' pp' }));` line — the `' pp'` is now part of `price`.

- [ ] **Step 3: Check it in a headless browser**

Start a second server and run a check script (scratch, not committed):

```bash
PORT=3031 node --env-file-if-exists=.env server.js & SRV=$!; sleep 1
cat > "$TMPDIR/check-cabins.mjs" <<'EOF'
import { launch } from './browser.js';
const b = await launch(); const p = await b.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.setViewport({ width: 800, height: 600 });
await p.goto('http://localhost:3031/', { waitUntil: 'networkidle0' });
await p.click('.yearchip'); // "All"
await p.select('#f-cabin', 'balcony');
console.log('balcony:', await p.$eval('#count', (e) => e.textContent));
console.log('first price label:', await p.$eval('.card .cabin', (e) => e.textContent));
console.log('cabin rows:', await p.$eval('.cabins', (rows) => rows.slice(0, 3).map((r) => r.textContent)));
console.log('page errors:', errors.length ? errors : 'none');
await p.screenshot({ path: process.env.TMPDIR + '/cabins-800.png' });
await b.close();
EOF
cp "$TMPDIR/check-cabins.mjs" ./check-cabins.tmp.mjs && node ./check-cabins.tmp.mjs; rm ./check-cabins.tmp.mjs
kill $SRV
```

Expected (with the data from before Task 6's scrape, which has no tables yet): the page loads with **no page errors** — proving `/search.js` imports — and choosing Balcony behaves as it did before (the old-data fallback). Look at `$TMPDIR/cabins-800.png`: the layout holds. The full behaviour is checked after the scrape in Task 6.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Price cards, the cabin filter and the sort by the chosen cabin"
```

---

### Task 6: Full scrape, live checks, and the record

**Files:**
- Modify: `CLAUDE.md`
- Writes (untracked): `data/sailings.json`

- [ ] **Step 1: Full scrape**

```bash
node scrape.js; echo "exit: $?"
```

Expected: exit 0; the same four lines and counts as the last scrape (±a few); in `unrecognised`, only Princess `row … missing price` entries and possibly `cabin: "Lanai"` (Holland America's unmapped cabin, reported by design).

- [ ] **Step 2: Check the data**

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs"; import { searchSailings, upcoming, localDate } from "./search.js";
const d = JSON.parse(readFileSync("data/sailings.json","utf8")); const all = upcoming(d.sailings, localDate());
const kinds = {}; for (const s of all) { const k = s.line + ": " + (s.cabinPrices === null ? "not listed" : "table"); kinds[k] = (kinds[k] || 0) + 1; }
console.log(kinds); console.log("values.cabin", d.values.cabin);
console.log("cheapest always in own table:", all.every(s => s.cabinPrices === null || s.cabinPrices[s.cabin] === s.price));
const wk = searchSailings(all, { destination: "alaska", nights: 7, cabin: "balcony" });
const by = {}; wk.forEach(s => by[s.line] = (by[s.line] || 0) + 1); console.log("a week in Alaska with a balcony:", wk.length, by);
console.log("... under $2,000:", searchSailings(all, { destination: "alaska", nights: 7, cabin: "balcony", maxPrice: 2000 }).length);'
```

Expected: Royal Caribbean, Celebrity and Holland America all `table`, Princess all `not listed`; `values.cabin` is all four types; the invariant `true`; "a week in Alaska with a balcony" in the hundreds, from Holland America, Celebrity and Princess; the `under $2,000` count smaller.

- [ ] **Step 3: Check the page — Peter does this**

The server reloads the data by itself; restart it for the code (`Ctrl-C`, `npm run serve`). Then:

- "a week in Alaska with a balcony" — results, priced and labelled **Balcony**; Princess cards say **"Balcony price not listed · from $… interior"**.
- "a balcony under $2,000 in Alaska" — every priced card at or under $2,000.
- No search, Cabin dropdown → **Balcony** — the same kind of results; switch to **Interior** and the prices drop.
- Each card shows a row like *Interior $959 · Ocean view $1,009 · Balcony $1,459 · Suite $2,164*.
- At about 800×600 the cards still lay out.

- [ ] **Step 4: Update `CLAUDE.md`**

- Status: the new figures and the test count.
- A short paragraph under Status: per-cabin prices — `cabinPrices`, `priceFor` as the one rule shared by server and page, Princess "not listed", and that `price`/`cabin` remain the cheapest.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "Record per-cabin prices in the project status"
```
