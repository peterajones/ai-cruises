# Princess.com fixture capture — notes for Task 6

Captured 2026-08-04 with `tools/capture-fixture.js`. Site is **JSON-driven**
(a Next.js SPA backed by a JSON API at `gw.api.princess.com`), not
server-rendered. No bot wall was seen on any of the 10 page loads made during
this capture (`detectBotWall` never fired a warning).

**Important finding: the sailings catalog and the pricing data are two
separate API calls, on two separate pages, and price is not on the catalog
object at all.** This is the single biggest thing Task 6 needs to know before
writing an adapter. Details below.

## 1. The listing URL and the response that carries sailings

- Listing page opened: `https://www.princess.com/en-us/cruise-search`
- This page's own JSON response is `.../resdb/p1.0/products?...&light=true`
  (URL substring to match on: `resdb/p1.0/products`). It was by far the
  largest JSON response on the page (150KB vs. next-largest 37KB), matching
  the brief's "largest response" heuristic.
- Saved verbatim as `test/fixtures/princess-listing.json`.

**But this `light=true` products response is an itinerary/calendar index, not
a list of priced sailings.** Each entry is an *itinerary template* — one row
covers several ships and every date each ship sails that itinerary — and it
has no price, no cabin, and no per-departure id. See field mapping below for
what it does have.

To get actual prices I opened a second page,
`https://www.princess.com/cruise-search/results/?ship=DI` (the "View
Cruises" link on a ship page — see §4), and listed its JSON responses. That
page calls a *different* products endpoint (same URL shape, `light` param
absent, includes real cabin `metas`/`subMetas`) and, separately, a pricing
endpoint:

- `.../internal/caps/pc/pricing/v1/cruises` (URL substring:
  `caps/pc/pricing/v1/cruises`) — 313KB for ship DI, 116 itineraries.
  Saved as `test/fixtures/princess-pricing.json`.

This response was served with **no query string** on `response.url()`,
meaning it's very likely a POST with a JSON body (ship code, maybe a date
range) — the capture tool only records GET-style URLs, so I could not see
what request produced this specific set of results. That's a real gap: I
don't know how to ask this endpoint for a specific future date, only that
requesting `?ship=DI` returns pricing for what looks like one (probably the
earliest available) departure per itinerary.

## 2. JSON path to the array of sailings

- Catalog (`princess-listing.json`): `products` — a flat array, 1015 items.
  Each item is one itinerary-template, e.g.:
  ```json
  {
    "id": "ANG07A",
    "trades": [{ "id": "A" }],
    "embkDbkPortIds": ["YVR", "WH1"],
    "cruiseDuration": 7,
    "ships": [{ "id": "IP", "sailDates": ["20260805", "20260819", ...] }, ...]
  }
  ```
  A single item can expand to dozens of real sailings (one per ship × per
  sailDate). There is no flat "one row = one sailing" array here — Task 6's
  adapter will need to do that expansion itself if it uses this endpoint.

- Pricing (`princess-pricing.json`): also `products`, 116 items, shaped:
  ```json
  {
    "id": "OSR10A",              // same itinerary id space as the catalog
    "cruises": [{
      "id": "M634",              // looks like a real per-departure sail id — no date on it though
      "pricing": {
        "fareCurrency": "USD",
        "fares": [{
          "fareType": "BESTFARE",
          "metas": [{ "id": "B", "bestCategory": "BC", "status": "A" }, ...],
          "categories": [{
            "id": "BC",
            "guests": [{ "id": 1, "fare": 3245, "baseFare": 3094, "brochureFare": 4047 }, ...]
          }, ...]
        }]
      }
    }]
  }
  ```
  Every product in this sample had exactly one `cruises[]` entry.

## 3. RawSailing field mapping

None of these fields live on one object. This is a composite, built by
joining the catalog row, the pricing row (matched by itinerary `id`), and
three small reference lookups also captured here (`princess-ships-ref.json`,
`princess-ports-ref.json`, `princess-trades-ref.json`).

| RawSailing field | Source | Notes |
|---|---|---|
| `externalId` | **Not directly available.** Catalog has only the itinerary id (`ANG07A`) shared by many departures. Pricing has `cruises[].id` (e.g. `"M634"`), which looks like a genuine per-departure id but carries no visible date, so I can't confirm it's stable per (ship, date). Safest synthetic id from the catalog alone: `` `${product.id}-${ship.id}-${sailDate}` ``. |
| `url` | **Not present anywhere captured.** The only link found is the ship page's "View Cruises" button, `https://www.princess.com/cruise-search/results/?ship=<shipId>` — a filtered search, not a per-sailing permalink. `url` is optional in `normalize.js` (`row.url ?? null`), so leaving it `null` is acceptable. |
| `ship` | Catalog: `product.ships[].id` (2-letter code, e.g. `"DI"`) → look up in `princess-ships-ref.json`'s `ships[]` array (`{id, name}`) for the display name, e.g. `DI` → `"Diamond Princess"`. 17 ships total. |
| `departurePort` | Catalog: `product.embkDbkPortIds[0]` (embarkation port code) → look up in `princess-ports-ref.json`'s `ports[]` array (`{id, name, isEmbark, isDisembark}`), e.g. `YVR` → `"Vancouver, Canada"`. 383 ports total. |
| `destination` | **Not the disembark port.** `normalize.js`'s `canonicalDestination` expects a *region* string ("Alaska", "Caribbean", ...), which matches `product.trades[0].id` → look up in `princess-trades-ref.json` (`{id, name}`), e.g. `A` → `"Alaska"`. This maps straight onto the `DESTINATIONS` keys in `normalize.js`. Do **not** use `embkDbkPortIds[1]` for this field — that's the disembarkation port (e.g. `"Anchorage (Whittier), Alaska"`), not a region. |
| `departureDate` | Catalog: `product.ships[].sailDates[]`, format `YYYYMMDD` (e.g. `"20260805"`) — needs reformatting to `YYYY-MM-DD` before `toIsoDate` will accept it (currently `toIsoDate` doesn't handle bare `YYYYMMDD`, only `YYYY-MM-DD`/slash/named-month forms — the adapter must insert dashes itself: `` `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` ``). |
| `nights` | Catalog: `product.cruiseDuration` (integer, e.g. `7`). Assumed to already mean nights (industry convention: a "7-day Alaska cruise" = 7 nights), but I found no fixture text that states this explicitly — worth a spot check in Task 6. |
| `cabin` | Pricing only: `cruises[].pricing.fares[0].categories[].id` is a fare-category code (`"BC"`, `"OC"`, `"IF"`, ...). Map it back through the sibling `metas[]` array (`metas[].bestCategory === category.id`) to get the letter (`B`/`O`/`I`/`M`/`S`), then: `B`→balcony, `O`→oceanview, `I`→interior, `M`/`S`→suite (per `normalize.js`'s existing `CABINS` groups, which already fold "mini suite" into `suite`). Not present in the catalog at all. |
| `price` | Pricing only: `categories[].guests[]`, take the entry with `id: 1` and read `.fare` (not `.baseFare` or `.brochureFare` — `fare` is the actual sell price; `brochureFare` is the crossed-out "was" price). Not present in the catalog at all. |

**`price` is in `normalize.js`'s `REQUIRED` array.** Every row from the
catalog alone (`princess-listing.json`) will fail normalization on that
missing field. Task 6 cannot ship an adapter that reads the catalog only —
it has to also call/parse the pricing endpoint and join on itinerary id, or
the entire fixture yields zero normalized sailings.

## 4. Sailing counts

- `princess-listing.json`: 1015 itinerary-template rows, covering an unknown
  (larger) number of actual ship×date sailings — I did not count the
  expansion.
- `princess-pricing.json`: 116 itinerary rows, each with exactly 1 priced
  `cruises[]` entry (so 116 priced departures, all for ship `DI`/Diamond
  Princess, since the source page was `?ship=DI`).

## 5. Ship page and description selector

- Requested `https://www.princess.com/en-us/ships/discovery-princess` with
  `--html`. It did **not** 404 — it redirected/rendered as a different ship:
  canonical URL came back as
  `https://www.princess.com/ships-and-experience/ships/di-diamond-princess`
  (title "Diamond Princess"). So the real ship-page URL pattern is
  `/ships-and-experience/ships/<lowercase-code>-<slug>`, e.g. `di-diamond-princess`,
  not `/en-us/ships/<slug>`. Diamond Princess (`DI`) does appear in the
  catalog fixture, so the captured page is still a valid, real ship page —
  just not the one I asked for by name. Saved as
  `test/fixtures/princess-ship.html` (2MB).
- The hero section (`.cmp-hero-composite__content`) has only the ship name,
  no prose.
- The actual description prose is further down the page, inside:
  `div.cmp-column-container__item__copy > p`
  (the item's heading, `div.cmp-column-container__item__title h2`, reads "A
  luxury destination in itself" on this page). There's also a one-line
  summary in a `<script type="application/ld+json">` block under
  `@graph[0].description` and in `<meta name="description">`, if a shorter
  blurb is preferred over the prose paragraph.

## 6. Reference lookups captured (not in the original brief, added because
`ship`/`departurePort`/`destination` are all codes on the catalog, not names)

- `test/fixtures/princess-ships-ref.json` — `ships[]`: `{id, name}`, 17 ships.
- `test/fixtures/princess-ports-ref.json` — `ports[]`: `{id, name, countryId, isEmbark, isDisembark}`, 383 ports.
- `test/fixtures/princess-trades-ref.json` — `trades[]`: `{id, name}`, 15 regions (this is the `destination` source).

## Capture log (10 page loads total, all sequential, ≥1.5s apart — each
`node` invocation includes an 8s `politeDelay` plus puppeteer launch/navigate
overhead, so the real gap between loads was well over a minute each time)

1. `--list` on `/en-us/cruise-search`
2. `--match resdb/p1.0/products --out princess-listing.json`
3. `--html` on `/en-us/cruise-search` (DOM inspection, not committed)
4. `--match resdb/p1.0/ships` (ships reference)
5. `--match resdb/p1.0/ports` (ports reference)
6. `--match internal/ube` (booking-engine config; confirmed cabin-category letters, no per-sailing price)
7. `--html` on `/en-us/ships/discovery-princess` → `princess-ship.html`
8. `--list` on `/cruise-search/results/?ship=DI`
9. `--match caps/pc/pricing/v1/cruises --out princess-pricing.json`
10. `--match resdb/p1.0/trades` (trades reference)

## Concerns for Task 6

- **Two-call join required.** No single response has all 9 fields. The
  adapter needs the catalog (ship/port/date/nights) joined to the pricing
  call (cabin/price) by itinerary id, plus three reference tables to turn
  codes into names.
- **Pricing call parameters are unknown.** I only captured what
  `?ship=DI` on `/cruise-search/results/` returns, with no visible date
  filter. I don't know the request shape needed to get pricing for a
  specific ship+date rather than whatever single departure the site defaulted
  to. This may mean Task 6's adapter can only price "the next available
  departure" per itinerary rather than every date in `sailDates[]`, unless
  further reverse-engineering of the POST body is done.
- **`externalId` has no clean source.** Recommend a synthetic composite id
  from the catalog (`itineraryId-shipId-sailDate`) rather than trusting
  `cruises[].id`, since I couldn't confirm the latter is stable or maps
  1:1 to a specific date.
- **`robots.txt` disallows the pages that would have made this simpler**:
  `/find/cruiseDetails.do`, `/find/searchResults.do`, `/find/voyagePricing.do`,
  and the whole `/find-a-cruise/` tree are all disallowed. The two pages this
  capture used (`/en-us/cruise-search` and the ship pages) are not on that
  list, so the tool stayed within what's permitted, but it means the
  "obvious" pricing route was off-limits by the site's own rules and the
  actual route (via a ship page's "View Cruises" link) took extra digging
  to find.
