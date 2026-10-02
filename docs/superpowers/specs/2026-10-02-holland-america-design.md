# Holland America adapter, and cruisetours as a trip type — design

**Date:** 2026-10-02
**Status:** draft, awaiting review

## Purpose

Add Holland America as the fourth cruise line, to fix thin Alaska coverage: the
dataset has 49 Alaska sailings and none from Royal Caribbean. Holland America's
Alaska programme includes *cruisetours* — a cruise plus land days at Denali or the
Yukon, sold as one package — which no other line in the dataset carries. They are
included, and marked as their own kind of trip so their price and length are never
silently compared with a plain cruise's.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope | Alaska only | Fills the gap that motivated this. Widening later is one filter change. |
| Volume | Cap at 300 sailings, earliest first | Alaska alone is 859 dated sailings — more than the whole current dataset. 300 covers the 2027 season in ~15 requests. Raising it is one number. |
| Cruisetours | Included by default, flagged, and searchable | Showing with a caveat beats withholding (see CLAUDE.md, "What this is for"). Hiding them would bury most of the line's Alaska variety. |
| Price | Cheapest **refundable** (FLEXIBLE) fare | Peter's choice: the conservative figure. Note it differs from the other lines, which store their cheapest fare of any kind — so Holland America will read slightly high by comparison. This is deliberate, not a bug. |
| Currency | USD (`country=us`) | Probed 2026-10-02: the endpoint honours it (7-day Alaska Explorer: USD 1,449 vs CAD 1,999). Unlike Princess, which ignored the equivalent. |
| Ship descriptions | Decided by evidence in step 1 | Fetch one ship page; if it shows the right ship, read it as Royal Caribbean does, otherwise declare `shipDescriptions = false` as Princess does. |

## What the evidence shows

From `test/fixtures/holland-america-search.json` (captured 2026-08-05, CAD) and three
single-row probes on 2026-10-02.

- **The endpoint:** `GET https://www.hollandamerica.com/search/halcruisesearch`, Solr-style
  parameters. `start`/`rows` paginate. No bot wall seen.
- **988 in the fixture counts itineraries, not sailings.** The site's own query collapses on
  `itineraryId`. Without the collapse, Alaska reports 859 — so one row should be one dated
  sailing. *Inferred from the counts, not yet confirmed:* step 1 checks that an uncollapsed
  page holds the same itinerary on several dates.
- **Destination codes resolve in the same response.** `facets.destinations` carries
  `"ALASKA#@#A"`, `"EUROPE#@#E"` and ten more. No second request.
- **`#@#` packs name and code** in `shipName`, `embarkPortName`, the facets and `meta`.
  Split on it; never regex around it.
- **Price keys are `price_<CUR>_<cabin>_<fare type>_d`.** Fare types: `FLEXIBLE`
  (refundable), `RESTRICTED` (non-refundable deposit, cheaper), `anonymous`. About 600
  further keys per row carry promo codes (`HCA26…`, `HEP26…`) — targeted offers, never read.
  `-1` and `0` mean not available.
- **`launch_price_*` is the "was" price** — always above the matching `price_*` (1,655 vs
  1,124). Never read.
- **Cabin codes** are named in each row's `meta` (`"Inside#@#WE_IN"`). Codes seen: IN, OV,
  VN, LA, VS, NS, SS, PH.
- **Cruisetours:** `cruiseType` is `""` for a cruise, `LAND_FIRST` or `SEA_FIRST` for a
  cruisetour, with a `tourId`. Their `duration` is the whole package: "14-Day Ultimate
  Denali" starts on land in Fairbanks and runs 14 days. Alaska has 268 LAND_FIRST alone.
- **Links:** each row has `contentPath` (`/find-a-cruise/a6n07b/w656`). **No image field.**

## Design

### 1. The adapter — `sites/holland-america.js`

A new file, independent of the others, satisfying the existing adapter contract
(`parseListing`, `parseShip`, `fetchListingPages`, `fetchShipPage`, `shipUrl`).

- **Fetch:** query with `fq=destinationIds:A`, `fq=soldOut:false` (as the site's own query
  does), `country=us`, `language=en`, departures from tomorrow, 20 rows a page. "Earliest
  first" needs a sort parameter that has **not been tested**; step 1 confirms
  `sort=departDate asc` is honoured. If it is not, the cap takes whatever order the API
  returns, and the spec is revised. Sequential, with
  `politeDelay()` between pages and `detectBotWall()` on each response. Stop at 300
  sailings or when a page comes back short. `--limit N` caps it lower.
- **Parse:** one row → one raw sailing.
  - `ship`, `departurePort`: the name half of the `#@#` pair.
  - `departureDate`: `departDate`. `nights`: `duration`.
  - `destination`: each `destinationIds` code looked up in that response's
    `facets.destinations` table, then canonicalized by `normalize.js` as usual.
  - `tripType`: `cruise` when `cruiseType` is empty, `cruisetour` for `LAND_FIRST` or
    `SEA_FIRST`.
  - `price` and `cabin`: the lowest `price_<CUR>_<cabin>_FLEXIBLE_d` that is greater than
    zero, over the standard cabin codes; `cabin` is that cabin's name from `meta`.
    The currency is read from the key, so the CAD fixture and USD production both parse.
  - `url`: site origin + `contentPath`. `image`: null.
- **Cabin mapping** (in `normalize.js` `CABINS`, by the site's label): Inside → interior,
  Ocean View → oceanview, Verandah → balcony, Vista / Neptune / Pinnacle / Signature
  Suite → suite. **Lanai** (opens onto the promenade, not a private balcony) is confirmed
  against its `meta` label and real data before mapping; until then it is reported as
  unrecognised rather than guessed.

### 2. The data shape — `tripType`

- `normalize.js` adds `tripType` to every sailing: `row.tripType ?? 'cruise'`. Adapters
  that do not set it — all three existing ones — need no change.
- A value other than `cruise` or `cruisetour` is recorded in `unrecognised`. It is not a
  required field: an odd value never drops a sailing.
- `values.js` adds `tripType` to the derived enumeration.
- For a cruisetour, `nights` is the whole package, land and sea. No split is stored; the
  API does not provide one. The card label carries the caveat.
- No migration: the next full scrape rewrites every row.

### 3. Search and the page

- `brain.js`: `tripType` joins the filter schema, enum-constrained like `cabin`, null when
  unsaid — so a search returns both kinds by default. Prompt rules: "cruisetour", "land
  tour", "Denali", "Yukon" → `cruisetour`; "cruise only", "no land tour" → `cruise`.
- `search.js`: one filter line, `if (filter.tripType && s.tripType !== filter.tripType)`.
  `describeFilter()` says "cruisetours" or "cruises only".
- `public/index.html`: a cruisetour card shows **"Cruisetour · includes land days"** beside
  the nights. A **Trip type** option joins the manual filter dropdowns. Cards with no image
  are checked and fixed if they render broken.

## Testing and verification

Unit tests, test-first:

- The adapter against a fixture: the golden first row, `#@#` splitting, destination
  codes resolved from the facets, and the refundable-fare rule — including a row where a
  promo-code or `launch_price` key is lower, to prove neither is read.
- `normalize`: `tripType` defaults to `cruise`; an unknown value is reported.
- `search`: the `tripType` filter.

Live checks, because a green suite says nothing about whether the site agrees:

1. **Price against the site.** For one sailing, the adapter's refundable interior price
   must match hollandamerica.com. If it does not, stop and find out why.
2. **Small dry run** — `node scrape.js --site holland-america --limit 20 --dry-run`: Alaska
   rows, USD, a mix of cruises and cruisetours, no unrecognised values.
3. **Full scrape** only after both pass.

## Order of work

Each step is its own commit.

1. Evidence first: the ship-page check, `sort=departDate asc`, and one row per dated
   sailing. Then re-capture the fixture with `country=us`, Alaska, so tests match
   production's currency.
2. The adapter, registered in `sites/index.js`.
3. `tripType` through `normalize.js` and `values.js`.
4. Search: `search.js` and `brain.js`.
5. The page.
6. Live checks, then the full scrape.
7. `CLAUDE.md`: status, the refundable-fare difference, and the Holland America quirks.

## Out of scope

- Destinations other than Alaska.
- Images for Holland America cards.
- Splitting a cruisetour's nights into land and sea.
- Any change to how the other three lines choose their price.
