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

# Royal Caribbean fixture capture — notes for Task 8 (discovery only)

Captured 2026-08-04 with `tools/capture-fixture.js`. **No bot wall was seen on
any of the 4 page loads.** `detectBotWall` never fired, and manual inspection
of both HTML fixtures found no Akamai/Incapsula/PerimeterX/Cloudflare markers
(the only "Access Denied" string in `royal-caribbean-ship.html` is inside an
inert JS comment, `// fallback for IE11 Script Access Denied error`, not a
real block page). `robots.txt` was fetched with a normal browser UA (curl,
no evasion) and does **not** disallow `/cruises` or `/cruise-ships/`; only
`/mycruises/`, `/booking/`, `/room-selection/`, `/find` — n/a here — and a
handful of others are blocked.

**Verdict: this site is flatter than Princess. A single capture yields rows
that already carry all eight required fields — no join, no second endpoint,
no separate pricing call.** The landing page's own GraphQL response
(`/cruises/graph`) returns 10 fully-priced, fully-dated sailings on first
load (of a stated `total: 930`), and every field the brief asked about is
present on each row without any lookup table.

## 1. The listing URL and the response that carries sailings

- Listing page opened: `https://www.royalcaribbean.com/cruises` (no filters
  applied — the unfiltered landing page already renders priced results, so
  no destination/date-filtered search was needed).
- This page fires a GraphQL POST to `https://www.royalcaribbean.com/cruises/graph`
  (URL substring to match on: `cruises/graph`). Four responses hit that same
  URL on one page load (different GraphQL operations batched from the same
  page — likely search results, a filter/facet query, and two smaller
  supporting calls); the one worth keeping is unambiguously the largest
  (518062 bytes vs. 60465/23602/23602 for the others), matching the "largest
  response" heuristic used for Princess too.
- Saved verbatim as `test/fixtures/royal-caribbean-listing.json`.
- Because it's a POST-driven GraphQL endpoint (no query string on
  `response.url()`), I could not see or vary the request body — same
  limitation Task 6 hit on Princess's pricing call. I did not need to: the
  default landing-page query already returns priced, dated results.

## 2. JSON path to the array of sailings

`data.cruiseSearch.results.cruises` — a flat array, 10 items on this
capture, alongside a sibling `data.cruiseSearch.results.total: 930` (the
site paginates; this capture only has page 1).

Each item is **one fully-formed sailing row**, not a template. Example
(trimmed):

```json
{
  "id": "WN04MIA-1040267344",
  "productViewLink": "itinerary/4-night-bahamas-perfect-day-cruise-from-miami-on-wonder-WN4BH349?sailDate=2026-08-31&packageCode=WN4BH349&groupId=WN04MIA-1040267344&country=USA",
  "lowestPriceSailing": {
    "id": "WN4BH351_2026-08-31",
    "sailDate": "2026-08-31",
    "lowestStateroomClassPrice": {
      "price": { "value": 448.03, "currency": { "code": "USD" } },
      "stateroomClass": { "id": "INTERIOR", "content": { "code": "I" } }
    }
  },
  "masterSailing": {
    "itinerary": {
      "totalNights": 4,
      "sailingNights": 4,
      "departurePort": { "code": "MIA", "name": "Miami", "region": "Florida" },
      "destination": { "code": "BAHAM", "name": "Bahamas" },
      "ship": {
        "code": "WN",
        "name": "Wonder of the Seas",
        "stateroomClasses": [
          { "id": "INTERIOR", "name": "Interior", "content": { "code": "I" } },
          { "id": "OUTSIDE", "name": "Outside View", "content": { "code": "O" } },
          { "id": "BALCONY", "name": "Balcony", "content": { "code": "B" } },
          { "id": "DELUXE", "name": "Suite", "content": { "code": "D" } }
        ]
      }
    }
  }
}
```

## 3. Field-by-field mapping (the eight fields the brief asked about)

| Field | Status | Source |
|---|---|---|
| stable id | **FOUND** | `cruises[].id` (e.g. `"WN04MIA-1040267344"`) — a group id tying ship+port+itinerary together. A second, more per-departure-looking candidate also exists: `cruises[].lowestPriceSailing.id` (e.g. `"WN4BH351_2026-08-31"`, literally `packageCode_sailDate`). Both were unique across all 10 rows in this capture; did not verify long-term stability across repeat captures. |
| ship name | **FOUND** | `cruises[].masterSailing.itinerary.ship.name` (e.g. `"Wonder of the Seas"`), with a short code at `.ship.code` (`"WN"`). |
| departure port | **FOUND** | `cruises[].masterSailing.itinerary.departurePort.name` (e.g. `"Miami"`), code at `.departurePort.code` (`"MIA"`), region at `.departurePort.region` (`"Florida"`). |
| destination label | **FOUND** | `cruises[].masterSailing.itinerary.destination.name` (e.g. `"Bahamas"`, `"Caribbean"`), code at `.destination.code` (`"BAHAM"`). |
| departure date | **FOUND** | `cruises[].lowestPriceSailing.sailDate`, already `YYYY-MM-DD` (e.g. `"2026-08-31"`) — no reformatting needed, unlike Princess's bare `YYYYMMDD`. Also duplicated at `.lowestPriceSailing.startDate`. |
| nights | **FOUND** | `cruises[].masterSailing.itinerary.totalNights` (integer, e.g. `4`), duplicated at sibling `.sailingNights` — both agreed on every row checked. |
| cabin tier label | **FOUND** | `cruises[].lowestPriceSailing.lowestStateroomClassPrice.stateroomClass.id` (e.g. `"INTERIOR"`) — a stable enum-like id (`INTERIOR`/`OUTSIDE`/`BALCONY`/`DELUXE` seen). Display name is one hop away: match that id against `masterSailing.itinerary.ship.stateroomClasses[].id` to get `.name` (e.g. `"Interior"`) and a single-letter `.content.code` (`"I"`). This is the *cheapest* cabin tier only (`lowestStateroomClassPrice`) — same "cheapest wins" shape the brief expects, not a full per-cabin price list. |
| price | **FOUND** | `cruises[].lowestPriceSailing.lowestStateroomClassPrice.price.value` (e.g. `448.03`), with currency at sibling `.price.currency.code` (`"USD"`). Also carries `originalAmount`, `netAmount`, `discountAmount`, `taxesAndFeesAmount`, `areTaxesAndFeesIncluded` if a richer price breakdown is ever wanted — `value` is the one to use for a straight "the price" field. |

**All eight fields live on one object, one response, one page load.** Verified
across all 10 rows in the fixture: every row has a unique `id`, unique
`lowestPriceSailing.id`, non-null ship/port/destination names, a
`YYYY-MM-DD` `sailDate`, an integer nights value, a cabin tier id+name, and a
priced `value`+`currency.code`. No row was missing any field. This is the
direct opposite of the Princess finding — there is no catalog/pricing split
here to reverse-engineer.

## 4. Second route checked: rendered DOM

Per the brief, I also captured the same `/cruises` URL with `--html` after
results rendered (`test/fixtures/royal-caribbean-listing.html`, 1.89MB) to
confirm the site's own front end performs no cross-page join a JSON-only
capture would miss. It doesn't need to here (the JSON already has
everything), but for completeness: the rendered cards (class
`RefinedCruiseCard-styles__RefinedCruiseCardBase-...`) do carry ship name,
price (`448.03` appears literally in the DOM) and nights (child class
`RefinedCruiseCardTotalNights-...`) directly in card markup — "Wonder of the
Seas" appears 8 times in the rendered HTML. Both routes are viable; the JSON
route is far more structured and was used for the saved fixture.

## 5. Ship page

- Requested `https://www.royalcaribbean.com/cruise-ships/wonder-of-the-seas`
  with `--html`. Resolved directly (no redirect), title `"Wonder of the Seas
  | Cruise Ships | Royal Caribbean Cruises"`. Saved as
  `test/fixtures/royal-caribbean-ship.html` (1.1MB).
- Two `<script type="application/ld+json">` blocks exist but only carry
  review/rating schema.org data, no prose description.
- Real prose description lives in a `.introCopy`-headed section: the
  paragraph immediately following `<span class="introCopy">...</span></h2>`,
  specifically inside `<p><span class="text-darker-gray"><span
  class="p">...</span></span></p>` (e.g. "From endless onboard thrills to
  gourmet globetrotting and top-notch shows, Wonder of the Seas® surprises
  with thrills and wow-worthy experiences at every turn..."). A shorter
  one-line blurb is also available at `<meta name="description">`.

## Capture log (4 page loads total, all sequential, ≥1.5s apart — each
`node` invocation includes the same 8s `politeDelay` plus puppeteer
launch/navigate overhead used for Princess, so real spacing was well over a
minute)

1. `--list` on `/cruises` — 72 JSON responses, no bot-wall warning.
2. `--match cruises/graph --out royal-caribbean-listing.json` on `/cruises`.
3. `--html` on `/cruise-ships/wonder-of-the-seas` → `royal-caribbean-ship.html`.
4. `--html` on `/cruises` (DOM cross-check) → `royal-caribbean-listing.html`.

## Concerns for a future implementation task

- **Pagination unknown.** `total: 930` but only 10 rows came back on the
  unfiltered landing load; the GraphQL request is a POST with a body this
  tool can't see, so the page/offset/filter parameters needed to page
  through the remaining 920 are not captured here.
- **`id` vs `lowestPriceSailing.id` as the externalId.** Both look plausible
  and both were unique in this 10-row sample, but I only have one snapshot —
  did not verify either is stable if the same sailing is captured twice (a
  real concern, since `id` looks derived from ship+port+groupId rather than
  literally containing the sail date, while `lowestPriceSailing.id` does
  encode the date and reads more like a true per-departure key).
- **Cheapest-cabin-only.** Like Princess, this response gives the *lowest*
  price across cabin tiers, not a full per-tier price table — fine for the
  brief's "a cabin tier label" + "a price" requirement, but worth noting if
  a future task wants all four tiers priced.

## Verified run (2026-08-04)

End-to-end verification from Task 11.

**Commands and results:**

- `npm test`: 48 tests, 48 pass, 0 fail
- `node scrape.js --limit 5 --dry-run`: 5 sailings printed, no write
- `node scrape.js`: 200 sailings written to data/sailings.json
- Dry run / real run success criteria: all pass
  - sailings: 200 (≥40) ✓
  - incomplete sailings: 0 ✓
  - empty enumerations: none ✓
  - ships without description: 0 ✓
  - unrecognised values: 0 ✓
- Guard test (break RESULTS_MATCH): exit code 1, clean operator messages, debug snapshot written, `data/sailings.json` byte-identical before and after ✓

**Dataset summary:**

- 6 ships: Wonder of the Seas, Allure of the Seas, Icon of the Seas, Jewel of the Seas, Freedom of the Seas, Oasis of the Seas — all with descriptions
- Destinations: [Bahamas, Caribbean]
- Cabins: [balcony, interior, oceanview]
- Nights: [3, 4, 5, 6, 7, 9]
- Departure ports: [Fort Lauderdale, Miami]
- Price range: $334.08–$2226.29

# Holland America

Spec: `docs/superpowers/specs/2026-10-02-holland-america-design.md`.

## Capture (2026-10-02)

`test/fixtures/holland-america-alaska-us.json` — one response from `searchUrl(0)`:

```
https://www.hollandamerica.com/search/halcruisesearch?start=0&rows=20&country=us&language=en&sort=departDate+asc%2CcruiseId+asc%2CtourId+asc&fq=departDate%3A%5BNOW%2FDAY%2B1DAY+TO+*%5D&fq=destinationIds%3AA&fq=soldOut%3Afalse&fl=cruiseId%2CtourId%2CitineraryId%2CshipName%2CembarkPortName%2CdepartDate%2Cduration%2Cname%2CcruiseType%2CdestinationIds%2CcontentPath%2Cmeta%2Cprice_USD_*
```

- First capture: `numFound` 859. 20 docs, 24 Apr – 9 May 2027, ascending; 11 cruises then 9 SEA_FIRST cruisetours.
- The three-field sort was accepted (HTTP 200, order as requested).
- First row: D733, Eurodam, Seattle, 2027-04-24, 7 nights, Inside USD 1,449 (lowest
  FLEXIBLE: OV 1,499, VN 1,949, SS 2,654, NS 3,514; -1 for LA, VS, PH). Same price as the
  2026-10-02 probe of this sailing.
- The older `holland-america-search.json` (2026-08-05, `country=ca`, all destinations)
  stays: its tests prove the parser reads the currency from the key, not an assumption.

## Live checks

- Price against the site (Peter, 2026-10-02): D733 Inside shows **CA$1,323** — exactly the
  API's `price_CAD_IN_RESTRICTED_d`. The site redirects a Canadian visitor to /en/ca and
  shows CAD, and it shows no refundable fare at all. So the rule changed from "cheapest
  refundable" to "cheapest public fare": D733 is stored as USD 959 (its RESTRICTED USD fare).
- Recaptured the same day with `fl` = the three public fare patterns: 858 found, 120 price
  keys across CAD/AUD/GBP/USD/EUR, no promo-code or launch_price keys, 174 KB (was 388 KB).
- Dry run 2026-10-02: `node scrape.js --site holland-america --limit 40 --dry-run` → exit 0,
  40 sailings (2 requests), both trip types, destination `alaska` only, no duplicates, no
  unrecognised values.
