# ai-cruises

A cruise-listing scraper plus a natural-language search layer: describe the trip you
want in plain English (price, destination, dates, cabin type, amenities) instead of
filling in filter boxes.

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

**Three lines working:** Royal Caribbean (203), Celebrity (118), Princess (188) — 509
sailings, 11 ships with descriptions, prices $295–$9,411 USD and $314–$3,459 CAD.

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
  so "Eastern Caribbean" beats a bare "Caribbean".
- **Only ~15 of 20 cards per page are sailings**; the rest are promo tiles with no date.

**Cross-currency price searches are refused, not answered.** `search.js` compares bare
numbers, so "under $800" across USD and CAD would be silently wrong — every number looks
plausible. `currencyConflict()` detects it and returns an explanation instead of results.
Narrowing to one cruise line resolves it, because the guard judges the candidates rather
than the whole dataset.

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
