# More Like This Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "More like this" link on each cruise card replaces the results with the 12 closest cruises by ports, price and length, within two weeks of its date, and ✕ restores the previous results.

**Architecture:** One pure function in `search.js`, which the page already imports and which runs over the `state.all` the page already holds. `public/index.js` gains one piece of state, `state.moreLike`, which `render()` shows in place of the normal list.

**Tech Stack:** Node 24.15+, `node:test`, plain browser JavaScript. No new dependency, route or model call.

**Spec:** `docs/superpowers/specs/2026-11-03-more-like-this-design.md`

## Global Constraints

- Work on a branch, `more-like-this`. Commit there; never push or merge without Peter's say-so.
- Tests need `nvm use` first (the machine's default Node is 22). Summary lines read `ℹ tests N`.
- Never add an inline `<script>` or `onclick=` to a page; `test/pages.test.js` fails. Build DOM with `el()` and `textContent`, never `innerHTML`: ship and port names are scraped text.
- `search.js` is served to the browser at `/search.js`: it can't import Node modules or `airports.js`.
- Any check that runs a second server sets both `DATA_DIR` and `SELECTIONS_FILE` to scratch, or it touches Peter's real ratings.
- Candidates depart within 14 days inclusive. Score = `0.6 × ports + 0.3 × (1 − price gap) + 0.1 × (1 − length gap)`. Top 12. CAD × 0.72, for ranking only.

## Review Focus

- Returning from a long scrolled list: cards are built 60 at a time, so ✕ must rebuild as many cards as were showing before restoring the scroll, or the page lands short.
- Starting from a card while a cabin is searched or chosen: match cards must show the cheapest cabin, and that cabin must be back after ✕.
- Clearing a view or a rating on a match while the My cruises chip is underneath: `render()` runs (`index.js:531`), and the matches must stay on screen.
- A source whose price or nights is 0 or missing: the gap must not become `NaN` or `Infinity` and scramble the order.
- Port names with letters that don't decompose (Tromsø, Ærø) must match their plain spellings, as `airports.js` folds them.

---

### Task 1: The rule

**Files:**
- Modify: `search.js`
- Test: `test/search.test.js`

**Interfaces:**
- Produces: `stopsOf(sailing) -> Set<string>`, and `moreLikeThis(source, sailings) -> { matches: Array<{ sailing, shared: number }>, stops: number, mixedCurrency: boolean }`. `shared` counts the match's stops also in the source; `stops` is the source's stop count; `mixedCurrency` is true when the source and its matches aren't all in one currency.

- [ ] **Step 1: Create the branch**

Run: `git switch -c more-like-this`
Expected: `Switched to a new branch 'more-like-this'`

- [ ] **Step 2: Write the failing tests**

Use a small inline builder, `const s = (over) => ({ id: 'a', line: 'L', ship: 'S', departureDate: '2027-05-15', nights: 7, price: 1000, currency: 'USD', departurePort: 'Vancouver', endPort: 'Vancouver', ports: ['Juneau', 'Skagway'], ...over })`.

```js
test('stopsOf tidies names so lines can be compared', () => {
  assert.deepEqual([...stopsOf(s({ ports: [
    'Juneau, Alaska', 'Glacier Bay National Park (Scenic Cruising), Alaska', 'Scenic Sailing: Hubbard Glacier, Alaska',
    'Scenic Cruising The Inside Passage', 'Tromsø', 'Reykjavík, Iceland', 'Cruising Hubbard Glacier',
  ] }))], ['juneau', 'glacier bay', 'hubbard glacier', 'the inside passage', 'tromso', 'reykjavik']);
});

test('stopsOf leaves out where the cruise starts and ends', () => {
  assert.deepEqual([...stopsOf(s({ departurePort: 'Vancouver, Canada', endPort: 'Seattle, Washington', ports: ['Vancouver, Canada', 'Juneau, Alaska', 'Seattle'] }))], ['juneau']);
});

test('moreLikeThis keeps candidates within 14 days either side, and never the source', () => {
  const source = s({ id: 'src' });
  const ids = moreLikeThis(source, [source,
    s({ id: 'early', departureDate: '2027-05-01' }), s({ id: 'tooEarly', departureDate: '2027-04-30' }),
    s({ id: 'late', departureDate: '2027-05-29' }), s({ id: 'tooLate', departureDate: '2027-05-30' }),
  ]).matches.map((m) => m.sailing.id);
  assert.deepEqual(ids.sort(), ['early', 'late']);
});

test('sailings with no stops are not candidates', () => {
  const source = s({ id: 'src' });
  assert.deepEqual(moreLikeThis(source, [source, s({ id: 'none', ports: [] }), s({ id: 'endsOnly', ports: ['Vancouver'] })]).matches, []);
});

test('ports outweigh price, and price outweighs length', () => {
  const source = s({ id: 'src' });
  const order = (...rest) => moreLikeThis(source, [source, ...rest]).matches.map((m) => m.sailing.id);
  assert.deepEqual(order(s({ id: 'cheap', ports: ['Sitka'] }), s({ id: 'samePorts', price: 1500 })), ['samePorts', 'cheap']);
  assert.deepEqual(order(s({ id: 'sameLength', price: 1500 }), s({ id: 'samePrice', nights: 10 })), ['samePrice', 'sameLength']);
});

test('CAD is compared at 0.72, and a mix of currencies is flagged', () => {
  const source = s({ id: 'src', price: 720 });
  const result = moreLikeThis(source, [source, s({ id: 'cad', price: 1000, currency: 'CAD' }), s({ id: 'usd', price: 900 })]);
  assert.deepEqual(result.matches.map((m) => m.sailing.id), ['cad', 'usd']);
  assert.equal(result.mixedCurrency, true);
  assert.equal(moreLikeThis(source, [source, s({ id: 'usd', price: 900 })]).mixedCurrency, false);
});

test('it shows the top 12, and counts the stops shared', () => {
  const source = s({ id: 'src' });
  const others = Array.from({ length: 20 }, (_, i) => s({ id: `o${i}`, ports: ['Juneau', 'Sitka'] }));
  const { matches, stops } = moreLikeThis(source, [source, ...others]);
  assert.equal(matches.length, 12);
  assert.equal(stops, 2);
  assert.equal(matches[0].shared, 1);
});

test('ties go to the closest date, then the id, so the order is repeatable', () => {
  const source = s({ id: 'src' });
  const rest = [s({ id: 'b', departureDate: '2027-05-20' }), s({ id: 'a', departureDate: '2027-05-10' }), s({ id: 'c', departureDate: '2027-05-16' })];
  const ids = (list) => moreLikeThis(source, [source, ...list]).matches.map((m) => m.sailing.id);
  assert.deepEqual(ids(rest), ['c', 'a', 'b']);
  assert.deepEqual(ids([...rest].reverse()), ['c', 'a', 'b']);
});

test('a source with no usable price or nights still ranks by what it has', () => {
  for (const source of [s({ id: 'src', price: 0 }), s({ id: 'src', price: null }), s({ id: 'src', nights: 0 })]) {
    const ids = moreLikeThis(source, [source, s({ id: 'near' }), s({ id: 'far', ports: ['Sitka'] })]).matches.map((m) => m.sailing.id);
    assert.deepEqual(ids, ['near', 'far']);
  }
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test test/search.test.js`
Expected: FAIL, with `stopsOf` and `moreLikeThis` not exported by `../search.js`.

- [ ] **Step 4: Implement both in `search.js`, and export them**

Fold letters as `airports.js:95` does (`NFD`, then ø, æ, ß), in a copy: this file reaches the browser and can't import that one. Prefixes to remove: `scenic sailing:`, `scenic cruising`, `cruising`; a trailing ` national park`. A date gap comes from `Date.UTC`-parsed ISO strings, so clocks changing can't move the 14-day edge. A price or length gap is 0 when the source's own value isn't a positive number, otherwise capped at 1. Ports is shared ÷ all stops in either cruise. Add the constants `MORE_LIKE_DAYS = 14`, `MORE_LIKE_COUNT = 12`, `CAD_TO_USD = 0.72` and the weights. Follow the file's existing comment style, and say in a comment why this needs no model.

- [ ] **Step 5: Run the tests**

Run: `npm test 2>&1 | grep -E "^(✖ |ℹ (tests|pass|fail))"`
Expected: `ℹ fail 0`, and `ℹ tests` 9 above the count before this task.

- [ ] **Step 6: Commit**

```bash
git add search.js test/search.test.js
git commit -m "Rank sailings by how like one cruise they are"
```

### Task 2: The page

**Files:**
- Modify: `public/index.js`, `public/index.html`
- Test: `test/pages.test.js`

**Interfaces:**
- Consumes: `stopsOf`, `moreLikeThis` from Task 1, through the existing `/search.js` import.
- Produces: `state.moreLike`: `null`, or `{ source, matches, stops, mixedCurrency, shared: Map<id, number>, back: { scrollY, built } }`.

- [ ] **Step 1: Write the failing test**

In `test/pages.test.js`:

```js
test('the main page has a place for the More like this banner', () => {
  assert.match(read('index.html'), /id="more-like"/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/pages.test.js`
Expected: FAIL on the new test only.

- [ ] **Step 3: Add the banner's element and styles to `public/index.html`**

`<div id="more-like" class="more-like" hidden></div>` directly above `#results-bar` (line 338). Style it with the page's `--panel`, `--line`, `--muted` and `--accent` tokens, so dark mode comes with it, as `.results-bar` and `.foot` do. Add a `.more-like-link` style for the card's control, and a `.shares` style in the accent colour.

- [ ] **Step 4: Implement the state and the card control in `public/index.js`**

- `showMoreLike(s)`: keeps `back` from the existing `state.moreLike` when already showing matches, so ✕ always returns to the original results; otherwise records `window.scrollY` and `built`. Sets `state.moreLike`, calls `render()`, scrolls the banner into view.
- `leaveMoreLike()`: clears `state.moreLike`, calls `render()`, calls `appendCards(back.built - built)` when that is positive, then `window.scrollTo(0, back.scrollY)`.
- `cardFor`: when `!s.unlisted && stopsOf(s).size > 0`, add a `button` of class `more-like-link`, text `More like this`, as the body's last child, after `starsFor(s)`. Its handler calls `showMoreLike(s)`.
- `cardFor`: when `state.moreLike?.shared.has(s.id)`, add a `.shares` line after the ports: `Shares 4 of its 5 stops`, or `Shares no stops` when the count is 0. The numbers are `shared` and `state.moreLike.stops`.
- `chosenCabin()` returns `null` while `state.moreLike` is set.
- The top of `render()`: when `state.moreLike` is set, fill and unhide `#more-like`, set `#count` to `${n} closest`, clear `#results-note`, and show the matches through the existing `renderList` / `appendCards` path with no `applyFacets`. If there are no matches, show the existing `.empty` box with `No other cruises leave within two weeks of this one.` Otherwise hide `#more-like` and go on as now.
- The banner, in `el()` calls: `More like ${ship} · ${prettyDate(departureDate)}`; then `${itinerary} · ${money(price)} · closest first, within 2 weeks of its date`; when `mixedCurrency`, `Prices are in different currencies, so the price comparison is approximate.`; and a `✕ Back to results` button calling `leaveMoreLike()`.
- Set `state.moreLike = null` before `render()` in the handlers that leave the mode: year chips (`index.js:279`), facet dropdowns (`:356`), the price slider (`:367`), the sort (`:384`), and a successful search (`:729`).

- [ ] **Step 5: Run the tests**

Run: `npm test 2>&1 | grep -E "^(✖ |ℹ (tests|pass|fail))"`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add public/index.js public/index.html test/pages.test.js
git commit -m "Add More like this to the cruise cards"
```

### Task 3: Check it in a real browser, and record it

**Files:**
- Modify: `CLAUDE.md`, `TODO.md`
- Create (scratch only, not committed): a puppeteer script in the session's scratchpad

**Interfaces:**
- Consumes: the running page from Task 2.

- [ ] **Step 1: Start a copy on scratch data**

Copy `data/sailings.json` and `data/selections.db` to a scratch folder. Run `PORT=3032 DATA_DIR=<scratch> SELECTIONS_FILE=<scratch>/selections.db SYNC_URL= SYNC_KEY= node --env-file-if-exists=.env server.js`. The empty `SYNC_URL` and `SYNC_KEY` keep Refresh and pulls away from the live server; confirm the page shows no Refresh button.

- [ ] **Step 2: Script these checks at 800×600 and 390×844, and at 1440×900**

Each must pass, with the output shown:
- Discovery Princess (May 6, 2027): its banner shows; 12 cards; the first is Star Princess, and says `Shares 4 of its 5 stops`.
- Coral Princess (Sep 16, 2027): 12 cards from more than one line.
- Scroll past 60 cards, click More like this, then ✕: the same number of cards is built, and `scrollY` matches to within a few pixels.
- Search for a cabin ("a balcony to Alaska"), open matches: headline prices are the cheapest cabin; ✕: balcony prices are back. A search costs ~$0.002; one is enough.
- Open matches from the My cruises chip, clear a `Viewed ✕` on a match: the matches stay.
- Change a dropdown while matches show: the banner goes, and the filter applies to the previous results.
- A match's More like this: moves on; ✕ returns to the original results.
- The link, banner and `Shares` line don't overflow or wrap badly at 390×844; take a screenshot and look at it.

- [ ] **Step 3: Read the results for Peter's four rated cruises**

Print each one's 12 and read them. Say plainly if any look wrong, and fix the rule or raise it before going on.

- [ ] **Step 4: Stop the copy, and record the feature in `CLAUDE.md`**

Add a **More like this** paragraph under Status, after **My cruises**: the spec's path, the rule in two lines, and that it needs no model. Update the test count from `npm test`. Tick the item in `TODO.md` (`- [x]`). Add `**Status:** COMPLETE` to this plan.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test 2>&1 | grep -E "^(✖ |ℹ (tests|pass|fail))"`
Expected: `ℹ fail 0`, with the count matching what `CLAUDE.md` now says.

```bash
git add CLAUDE.md TODO.md docs/superpowers/plans/2026-11-03-more-like-this.md
git commit -m "Record More like this in the project notes"
```

- [ ] **Step 6: Hand over to Peter**

Give him `git log --oneline main..more-like-this` and the commands to run it himself. Merging, pushing and deleting the branch each need his go-ahead. Remind him to run `npm run review` in `~/Projects/review-harness` once the tick is in. Remove `.superpowers/` once this has landed.
