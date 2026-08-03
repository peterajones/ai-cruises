# Cruise listing scraper — design

**Date:** 2026-08-03
**Status:** approved for planning

## Purpose

Produce the dataset that the natural-language cruise search reads. The scraper's
output is the cruise equivalent of shoe-store's `SHOES` array *plus* its `VALUES`
enumeration — and the enumeration matters as much as the data, because it is what
`brain.js` puts in its prompt to keep a 7B model from inventing values.

No AI in the scraper. Structured filtering and canonicalizing are rules you can
specify, so they get written as rules.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Target | Princess and Royal Caribbean in v1 | Every reachable aggregator is bot-walled or disallows its listing endpoint (see Target selection). Lines' own sites serve their search paths and expose results as JSON. |
| Fuzzy attributes | Store prose, infer nothing | Search over hard fields works immediately; inference later is a pass over stored data, not a re-scrape. |
| Storage | `data/sailings.json`, manual re-run | Zero storage machinery, human-readable. Dated copies in `data/runs/` keep price history possible. |
| Depth | Listing pages + one detail page per *ship* | "Vibe" is a property of the ship, not the sailing. ~40 extra loads instead of thousands. |
| Browser | Puppeteer | Familiar from MyFinances; confined behind the adapter seam, so swapping to Playwright later is four functions. |

Dependencies: `puppeteer`, and nothing else. Tests use `node --test`.

## Target selection

Measured 2026-08-03 with a plain `curl` using a desktop Chrome user agent:

| Site | Result |
| --- | --- |
| Cruise.com | Imperva/Incapsula challenge page on `/` and `/search`; `robots.txt` returns an empty body |
| CruiseDirect | HTTP 403 |
| Cruises.com, Cruiseline.com | 212-byte challenge stubs |
| Vacations To Go | 128 KB of server-rendered HTML, no wall — but listings come from `/fastdeal.cfm`, which its `robots.txt` disallows |
| Princess | 24 KB SPA shell, no wall, `/cruise-search` not disallowed |
| Royal Caribbean | Loads, no block on `/cruises`, Akamai present in the stack |

Working around a bot wall is explicitly out of scope. It is a different project
from this one, it breaks whenever the vendor retunes, and the entire design rests
on parsing being boring and stable.

Cruise lines' own sites cost breadth — one line's inventory per adapter rather than
40 lines in one — and cost nothing architecturally, because the adapter seam already
makes each additional source a new file. They also produce cleaner enumerations,
since one line names its destinations consistently where aggregators mix conventions.

## Layout

```text
ai-cruises/
  scrape.js          entry point:  node scrape.js [--limit N] [--site S] [--refresh-ships] [--dry-run]
  sites/
    index.js         adapter registry
    princess.js      the only files that know anything about a specific website
    royal-caribbean.js
  browser.js         puppeteer launch, polite delay, bot-wall detection
  normalize.js       raw site rows -> canonical Sailing shape
  values.js          derives the VALUES enumeration from scraped data
  persist.js         atomic write, run snapshots, ship cache merge
  data/
    sailings.json    what the search server reads
    runs/            dated copies of previous runs
    debug/           HTML snapshot of any page that failed to parse
  test/
    fixtures/        real saved pages, committed
```

## The adapter contract

The load-bearing interface. An adapter knows one site and returns **site-shaped**
objects; it does no canonicalizing.

```js
export const name = 'princess';
export const line = 'Princess';

export async function fetchListingPages(page, { limit });  // -> raw payload strings
export function parseListing(payload);                     // -> RawSailing[]   (pure)
export async function fetchShipPage(page, ship);           // -> raw HTML
export function parseShip(html);                           // -> { line, description }  (pure)
```

Splitting `fetch` (needs a browser) from `parse` (pure string to objects) is
deliberate: the fiddly half becomes testable against a saved fixture with no
network and no Puppeteer.

Where a site renders results client-side from a JSON endpoint, `fetchListingPages`
captures that response via `page.on('response')` rather than reading the DOM. JSON
the site already produces is far more stable than CSS selectors over its markup.

## Output shape

```js
// data/sailings.json
{
  scrapedAt: '2026-08-03T22:40:00Z',
  sailings: [{
    id: 'princess:12345',          // site-prefixed, so IDs never collide across sites
    source: 'princess',
    url: 'https://…',
    line: 'Princess',
    ship: 'Sky Princess',
    departurePort: 'Fort Lauderdale',
    destination: 'caribbean-east', // canonical
    departureDate: '2027-01-16',   // ISO 8601 date
    nights: 7,
    cabin: 'balcony',              // canonical; cheapest tier listed
    price: 1299,                   // per person
    currency: 'USD',
  }],
  ships: {
    'Sky Princess': { line: 'Princess', description: '…prose…', url: '…' }
  },
  values: { line: [], destination: [], cabin: [], departurePort: [], nights: [] },
  unrecognised: [{ field: 'destination', raw: 'Panama Canal - Partial Transit', count: 3 }],
}
```

### `values` is derived, never hand-written

`brain.js` builds its system prompt by enumerating every legal value. If that list
drifts from what is actually in the file, the model confidently emits `"alaska"`
while the data says `"alaska-inside-passage"`, and every such search silently
returns nothing. Deriving the enumeration from the scraped sailings makes the drift
structurally impossible.

### Canonicalizing lives in `normalize.js`

Sites write "Caribbean - Eastern", "E. Caribbean" and "Eastern Caribbean" for one
thing. `normalize.js` holds small explicit maps — readable, correctable, no model.

Anything a map does not recognise is recorded in `unrecognised` with its raw value
and a count, rather than being dropped. That is the scraper-side half of the problem:
it tells you which destinations and cabin names the maps are missing, so the
enumeration can be corrected instead of quietly losing sailings.

The search-side half is separate and out of scope here: `brain.js` needs its own
`unrecognised: []` field so an unmappable *request* ("anything with a Michelin
restaurant") is reported rather than becoming an all-null filter that matches
everything — shoe-store's known gap. This spec only guarantees the data it needs:
accurate, derived `values`.

## Failure handling

Scrapers fail silently and destructively. These guard the specific ways.

- **Atomic write.** Build the full result in memory, write `sailings.json.tmp`,
  rename on success. A crash never leaves half a file where a good one was.
- **Empty-result guard.** Zero rows from `parseListing` is a *failure*, not "no
  cruises match". The classic scraper bug is a changed selector parsing every page
  to nothing and overwriting good data with an empty array. Zero rows aborts.
- **Bot-wall detection.** A 403, a challenge page, or a body with no results
  container raises a distinct error — "looks like a bot wall, not a parse failure" —
  and snapshots the HTML to `data/debug/`. The two failures need different fixes, so
  they must not look alike.
- **Politeness.** One browser, sequential loads, ~1.5s between pages, realistic user
  agent, no concurrency. Nothing here needs to be fast, and an IP block costs a day.
  Respect `robots.txt` for the listing path.
- **Partial success is fine.** A failed ship page does not kill the run: the sailing
  is kept, its description absent. Failures accumulate into a summary printed at the
  end, and the process exits non-zero if any occurred.
- **Ship caching.** Ship descriptions are reused between runs unless `--refresh-ships`
  is passed. A ship's blurb changes roughly never.

## Empty states

Three different situations produce "nothing here", and they want opposite tones.
Conflating them is how a broken scraper gets mistaken for an empty ocean.

| Situation | Audience | Tone |
| --- | --- | --- |
| Scraper parsed 0 rows | Operator, at the terminal | Alarming — something broke |
| Search matched nothing | User, mid-search | Light |
| Filter contained an unmappable term | User, mid-search | Helpful — name the term |

**Scraper, 0 rows** — in scope here. Stays blunt, and never jokes:

```text
Parsed 0 sailings from listing page 1.
This usually means the selectors broke or you hit a bot wall.
Payload saved to data/debug/princess-listing-2026-08-03T22-51-04.json
Aborting without writing data/sailings.json.
```

**Search, no matches** — search-layer behaviour, specified here so it does not get
invented ad hoc later. Adapts to whether the filter names a destination:

```js
// destination present → "No Alaska cruises matched — you've had enough sun anyway."
// no destination      → "Nothing matched that search — you've had enough sun anyway."
```

**Search, unmappable term** — reads from the filter's own `unrecognised` field and
names what it dropped, rather than silently ignoring it:

> Found nothing. I understood *7 nights*, *balcony* and *under $1500* — but nothing
> in the listings describes "**Michelin restaurant**", so I ignored it.

The second and third are implemented with the search UI, not the scraper. They are
recorded here because the third is the entire reason `unrecognised` exists, and a
spec that builds the field without saying what it is for invites it being built and
then never read.

## Testing

`node --test`. No Jest — it would be a second dependency and the pure functions do
not need it.

- `test/fixtures/princess-listing.json`, `test/fixtures/royal-caribbean-listing.json` —
  real captured payloads, committed, one per adapter. `parseListing(fixture)` returns a
  known row count and a first row matching a committed golden file.
- `normalize.js` — table-driven: the three Eastern Caribbean spellings all map to
  `caribbean-east`; an unmapped value lands in `unrecognised` rather than vanishing.
- `values.js` — derives the correct enumeration from a small hand-written sailing set.

**Not tested: `fetchListingPages`.** It needs the live internet; a test for it would
be testing Princess's uptime. It gets a manual smoke command instead:
`node scrape.js --limit 5 --dry-run` prints what it would write without touching
`data/`.

## Success criteria

```bash
node scrape.js --limit 50
```

produces `data/sailings.json` where:

- there are at least 40 sailings;
- every sailing has a non-null `line`, `ship`, `departureDate`, `nights` and `price`;
- every `values` enumeration is non-empty;
- `ships` has an entry for every distinct ship name appearing in `sailings`.

Then, with the shoe-store-style search server running, "a 7-night Caribbean balcony
under $1500 leaving from Florida" returns a filter that is legible on the page and
results that match it.

## Out of scope for v1

Additional sites; model-based enrichment of ship prose; price-drop tracking across
runs; scheduling; per-sailing detail pages; cabin tiers beyond the cheapest listed.
