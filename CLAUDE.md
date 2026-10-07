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

- `sites/royal-caribbean.js`, `sites/celebrity.js`, `sites/princess.js`,
  `sites/holland-america.js` — one file per site, each knowing only its own site.
  Deliberately near-duplicates rather than a shared parser: when one site changes shape,
  the others keep running.
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

**Four lines working** (scraped 2026-10-07): Royal Caribbean (179), Celebrity (117),
Princess (198), Holland America (760) — 1,254 sailings, every one with a destination and a
trip type, 14 ships with descriptions, cheapest prices $298–$6,439 USD and $347–$3,451 CAD.
Alaska: 773 sailings (Holland America 760, Princess 13). 159 tests.

**Prices per cabin type.** Every sailing has `cabinPrices` — cabin type → that cabin's
cheapest price, e.g. `{ interior: 959, oceanview: 1009, balcony: 1459, suite: 2164 }` — and
`price`/`cabin` stay the cheapest overall. A cabin search means "offers this cabin", and a
price limit applies to that cabin's price, so "a balcony under $2,000" compares balconies.
`priceFor(sailing, cabin)` in `search.js` is the one rule: the server's search uses it, and
the page imports the same file (served at `/search.js`) for the Cabin dropdown, the price
slider, the sort and each card's headline price. Princess lists only its cheapest cabin, so
its `cabinPrices` is `null`: in a search for another cabin its cards say "Balcony price not
listed · from $… interior". Spec: `docs/superpowers/specs/2026-10-03-cabin-prices-design.md`.

**Celebrity and Royal Caribbean read one results page each**, and the site chooses what is
on it. Coverage by destination drifts between scrapes: Celebrity had 36 Alaska sailings on
2026-10-02 and none on 2026-10-07. Asking their APIs per destination would fix it.

**Cruisetours are a trip type.** Every sailing has `tripType`: `"cruise"` or
`"cruisetour"` (a cruise plus land days, sold as one package — only Holland America has
them). `normalize.js` defaults it to `"cruise"`, so adapters that sell only cruises never
set it. Search returns both unless asked; "Denali", "land tour" or "cruisetour" narrow to
cruisetours, "cruise only" excludes them. Cards are labelled "Cruisetour · includes land
days", because a cruisetour's `nights` is the whole package, land included.

**Departed sailings are hidden.** `upcoming()` in `search.js` drops anything that left
before today (local time). The server applies it per request, not at load, so a running
server never serves a cruise that has sailed. A re-scrape is still what brings in new
sailings — the project sat for eight weeks once and 35 of 509 had departed.

Royal Caribbean, Celebrity and Holland America read a JSON API. **Princess parses the rendered results
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
- **Ship pages are not fetched at all.** The adapter exports `shipDescriptions = false`,
  and `scrape.js` skips ship pages for any adapter that says so. Before this, every full
  scrape fetched 17 pages only to report 17 "failures" and exit 1 — so exit 1 meant
  nothing. **Exit 1 now means something really failed.**
- **~9 sailings per scrape have no price** and are dropped — sold out or not yet priced.

**Holland America quirks worth knowing** (spec: `docs/superpowers/specs/2026-10-02-holland-america-design.md`):

- **Alaska only, capped at 750** — enough for one full season. The 2027 season is 715
  sailings, 577 of them cruisetours: one cruise is sold as up to 8 land packages, each its
  own sailing with its own price and page. ~38 polite requests per scrape.
- **Sailing ID is `cruiseId` + `tourId`.** `cruiseId` alone merges those packages.
- **Price is the cheapest public fare** (`RESTRICTED`, `FLEXIBLE` or `anonymous`) — the
  price the site shows. Checked live: D733 Inside reads CA$1,323 on the site, the API's
  RESTRICTED fare. Promo-code fares (`HEP26…`) and `launch_price_*` (the "was" price) are
  never read; the request's `fl` leaves them out.
- **Every response carries every currency** (USD, CAD, AUD, GBP, EUR) whatever `country`
  says. USD is used when present, any other currency otherwise. The *website* geolocates:
  a Canadian visitor is redirected to `/en/ca` and sees CAD.
- **`#@#` packs a value and a code** (`"Westerdam#@#WE"`); `unpack()` splits it.
- **Destination codes resolve from `facets.destinations`** in the same response.
- **No ship descriptions** (`shipDescriptions = false`): ship pages are client-rendered
  shells. **No images** either — the API has no image field.

**Cross-currency price searches get a notice, not a refusal.** `search.js` compares bare
numbers, so "under $800" across USD and CAD is approximate. `currencyNote()` returns the
results with a note saying so. It judges the candidates *before* the price filter — judging
the survivors would go quiet exactly when the comparison wrongly excluded every CAD sailing.

## To do

Nothing queued. Holland America's design and plan are in `docs/superpowers/specs/` and
`docs/superpowers/plans/` (2026-10-02).

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
