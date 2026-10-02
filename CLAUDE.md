# ai-cruises

A cruise-listing scraper plus a natural-language search layer: describe the trip you
want in plain English (price, destination, dates, cabin type, amenities) instead of
filling in filter boxes.

**What this is for:** a launching pad for finding interesting cruises — not a booking
system. Prices are indicative, not authoritative. That distinction decides design
arguments: prefer showing an approximate answer with a caveat over withholding it for
precision the app never claimed. The cross-currency price filter is the worked example —
it was built as a hard block, and softened to a notice once the purpose was clear.

## Architecture

A scraper that extracts and normalizes cruise listings from several cruise lines, structured
as fetch-then-parse stages:

```text
browser ──fetch──▶ HTML/JSON ──parse──▶ RawSailing[] ──normalize──▶ Sailing[] ──persist──▶ JSON
```

Each stage knows only its own inputs and outputs. Adapters live in `sites/`.

- `sites/royal-caribbean.js`, `sites/celebrity.js` — one file per site, each knowing only its
  own site. Deliberately near-duplicates rather than a shared parser: when one site changes
  shape, the other keeps running.
- `search.js` / `brain.js` / `server.js` / `public/` — the search layer over the scraped data.
  `brain.js` is the only file that calls a model.
- `normalize.js` — canonicalize destination/cabin labels via `DESTINATIONS` and `CABINS` mappings,
  enforce required fields, flag unrecognised values.
- `values.js` — derive the enumeration of every unique destination/cabin/port/nights/price
  across the dataset.
- `persist.js` — write atomically to `data/sailings.json` (write to temp file, move on success).

**Rule of thumb:** if you can specify the rule, write the rule. Field validation, normalization,
and enumeration are conditionals, not model calls. The model belongs only in the search layer
(that piece is not in this scraper).

## Running it

```bash
npm test                                  # unit tests, no network
node scrape.js --limit 5 --dry-run        # smoke test, writes nothing
node scrape.js                            # real run, writes data/sailings.json
```

Fixtures in `test/fixtures/` are real captured payloads. When a site changes shape,
re-capture with `node tools/capture-fixture.js` and update the golden first-row files.
Synthetic test data belongs inline in test files, never in `test/fixtures/`.

A scrape that yields zero parsed rows is treated as a failure and exits with code 1,
leaving the previous `data/sailings.json` untouched — a broken selector cannot overwrite
a good dataset.

## Environment

- Node 22. Dependencies: `puppeteer` (scraping) and `@anthropic-ai/sdk` (search). Nothing else.
- Ollama at `http://localhost:11434`, `qwen2.5-coder:latest` (7B) is the default.
  `qwen2.5-coder:1.5b-base` is a *base* model — not for chat or tool roles.
  `/api/chat` is POST-only; a 405 in the browser means it's running.
- `ANTHROPIC_API_KEY` lives in `.env` (gitignored) and is loaded natively by
  `node --env-file-if-exists=.env` — no `dotenv` dependency. `npm run serve` does this.
  The search layer uses `claude-haiku-4-5` (~$0.002/query). No `ant` CLI installed.
- Server runs on port 3030.

## Status

**Three lines working** (scraped 2026-09-30): Royal Caribbean (193), Celebrity (116),
Princess (195) — 504 sailings, every one with a destination, 14 ships with descriptions,
prices $298–$5,110 USD and $312–$3,854 CAD. 111 tests.

**Departed sailings are hidden.** `upcoming()` in `search.js` drops anything that left
before today (local time). The server applies it per request, not at load, so a running
server never serves a cruise that has sailed. A re-scrape is still what brings in new
sailings — the project sat for eight weeks once and 35 of 509 had departed.

Royal Caribbean and Celebrity read a JSON API. **Princess parses the rendered results
page**, because its API cannot produce a dated price: the catalog carries dates without
prices, the pricing endpoint carries prices with no date field at all, and for ~9% of
itineraries one price maps to several sail dates. The rendered card carries both.

Adapters are deliberately independent files, never a shared base. When one site changes
shape, the others keep running.

**Princess quirks worth knowing:**

- **Prices are CAD.** `?currency=USD` and the `/en-us/` path were both tried and ignored —
  the site geolocates. Stored honestly; nothing is converted.
- **No ship descriptions.** `/ships/<slug>` 404s for most of the fleet and returns HTTP 200
  with the *wrong ship* for others — `/ships/discovery-princess` serves Diamond Princess's
  page. `parseShip` returns nothing rather than something unverifiable.
- **Destination comes from the itinerary title**, not port countries. Port countries read a
  Caribbean cruise leaving Fort Lauderdale as "Florida" — true, and useless. `normalize.js`
  has `findDestination()`, which finds a known region inside a phrase, longest alias winning
  so "Eastern Caribbean" beats a bare "Caribbean". Titles often name a coast or state
  instead of a region ("Tasmania", "Hunter Coast", "Sea of Cortez"); each alias was chosen
  from the sailing's actual ports. New titles show up in a scrape's `unrecognised` list.
- **Only ~15 of 20 cards per page are sailings**; the rest are promo tiles with no date.
- **Every full scrape exits 1** because all 17 Princess ships report "no description
  parsed". That is the quirk above, not a breakage — but it means exit code 1 currently
  tells you nothing. Read the log. (Fixing this is on the to-do list below.)
- **~9 sailings per scrape have no price** and are dropped — sold out or not yet priced.

**Cross-currency price searches get a notice, not a refusal.** `search.js` compares bare
numbers, so "under $800" across USD and CAD is approximate. `currencyNote()` returns the
results with a note saying so. It judges the candidates *before* the price filter — judging
the survivors would go quiet exactly when the comparison wrongly excluded every CAD sailing.

## To do, in order

1. **Quiet the Princess description failures** so exit code 1 means a real problem again.
   Small.
2. **Holland America** — the next adapter, below. Bigger.

## Holland America (adapter #4)

**Everything needed to start is captured.** The evidence is
`test/fixtures/holland-america-search.json` (2.4 MB, real) — read it before probing
anything, and don't re-derive what is below.

**Why this line:** Alaska is its specialty, and it is the best-shaped source found so
far — a real search API, not a DOM scrape. Its first row is a Vancouver → Whittier
Glacier Discovery sailing. The current dataset has only 49 Alaska sailings (Celebrity 36,
Princess 13, Royal Caribbean none).

**The endpoint** — one GET, no POST body to reverse-engineer:

```
https://www.hollandamerica.com/search/halcruisesearch
  ?start=0&rows=20&country=ca&language=en
  &fq=departDate:[NOW/DAY+1DAY TO *]
  &fl=cruiseId,shipName,embarkPortName,disembarkPortName,departDate,duration,name,destinationIds,price_CAD_*,...
```

- `response.numFound` was **988** — roughly twice the entire current dataset.
- `response.docs` is the row array, 20 per page. `start`/`rows` are real pagination, so
  paging is a URL change rather than scroll-driving. Politeness still applies: sequential,
  `politeDelay()` between pages, and stop at a sane cap rather than pulling all 988 blindly.
- No bot wall across the probes made (HTTP 200, no Incapsula/Cloudflare/PerimeterX markers).

**Verified row shape** (`response.docs[0]`):

```json
{
  "cruiseId": "W656",
  "shipName": "Westerdam#@#WE",
  "embarkPortName": "Vancouver, B.C., CA#@#YVR",
  "disembarkPortName": "Whittier, Alaska, US",
  "departDate": "2026-08-16T00:00:00Z",
  "duration": 7,
  "name": "7-DAY GLACIER DISCOVERY NORTHBOUND",
  "destinationIds": ["A"],
  "price_CAD_IN_RESTRICTED_d": 1124
}
```

**Three quirks to design for, all already visible:**

1. **`#@#` packs two values into one string** — `"Westerdam#@#WE"` is name plus ship code,
   `"Vancouver, B.C., CA#@#YVR"` is port plus code. Split on it; do not regex around it.
2. **Price keys are dynamic**, with fare codes baked into the key name
   (`price_CAD_IN_RESTRICTED_d`, `launch_price_CAD_HEP26HOB4A_d`). There is no fixed path
   to read, so the adapter must scan keys by pattern. Cheapest-tier becomes "lowest
   `price_CAD_*`", and note `launch_price_*` looks like a list price — the Princess "Was
   vs Now" trap in a different costume, so establish which is which before trusting either.
3. **`destinationIds` are codes** — `["A"]` for Alaska. A reference table will be needed,
   same as Princess's trades/ports/ships lookups. Find where the site resolves them.

**Also CAD** (`country=ca`). Matters far less now that mixed currencies are noted rather
than blocked, but it is two of three lines in CAD, so it may be worth revisiting whether
`country=us` is honoured on this endpoint — Princess ignored the equivalent.

**Open questions to settle while planning:** how many of the 988 to take (a cap, or all of
them at 20/page = 50 requests); whether Holland America publishes usable ship descriptions,
given Princess's did not; and whether `destinationIds` resolve from a table on the page or
need a second request.

## Open questions

Noted, not decided. Don't act on these without asking.

**Sticky year chips.** The year row scrolls out of view and is easy to lose. `position: fixed`
is the wrong tool — it drops the row out of flow, so it needs a hand-maintained top offset
*and* a compensating margin below, both of which re-break whenever the header changes.
`position: sticky` with a `--header-h` variable set from a `ResizeObserver` on the header is
the fix, ideally paired with hiding the example chips on scroll to reclaim the height.
Deferred because it may not be a real problem — see the viewport note below.

**Verify UI on a small viewport before judging it.** Peter works on a 27" Studio Display, where
vertical space is abundant and scroll-loss is felt differently than on a laptop or phone. Any
layout judgement made only at that size is suspect in both directions — problems can look worse
than they are, and real small-screen problems stay invisible. Check at ~800×600 before calling
a layout question settled.

**Lazy loading.** Images already carry `loading="lazy"`, but the API ships all sailings in one
response and the page builds every card up front. Fine at ~320, not at 2,000. The 13 distinct
images are 900 KB–2.7 MB each (full 4K heroes rendered in ~290px cards). Celebrity's CDN honours
`?imwidth=600` (1043 KB → 75 KB); Royal Caribbean's ignores it, and its own parameter was not
found. Nothing is downloaded locally — image URLs are hotlinked.

## Working style

- Say what you're about to do, what Peter will run, and what success looks like —
  before doing it.
- Hand over the command and let him run it rather than reporting a summary of output.
- Build the smallest thing that *works* first; explore failure modes after.
- Never frame a failure as the intended outcome.
- Answer the question asked. Don't turn a question into a build session.
