# Cunard adapter — design

**Date:** 2026-10-14
**Status:** draft for review

## Purpose

Add Cunard as the sixth cruise line: its sailings searchable alongside the other five, with
photos, ports, per-cabin prices, an end port for the flights panel, and a destination.
Prices are orientative, like every price in this app.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Prices | Per cabin type (`cabinPrices`), from one price request per sailing | Peter's choice. The search API carries only the cheapest cabin, and its cabin filter changes *which* sailings come back, not the price (checked: filtered to Balcony, M626C still reads 504.74 Inside). Only `/api/v2/price/cruise/<id>` prices each cabin. |
| Volume | Sailings departing in the next 12 months | Peter's choice. Per-cabin prices for all 590 sailings would be ~710 requests (~18 min) on a site with Akamai bot protection; 12 months is roughly half. Matches Viking and what the flights panel can price (330 days). |
| Destinations | Cunard's own `destinationIds`, mapped by the table in section 3 | Peter approved the table as proposed, including Short Break → `europe` and a new `africa` destination. |
| Currency | CAD, as served | The site geolocates; its requests send `country: CA`, `currency: CAD`. Stored honestly, never converted. |
| Ship descriptions | None (`shipDescriptions = false`) | Not investigated; can be added later. |

## What the evidence shows (2026-10-14, read-only)

- **Search page** `https://www.cunard.com/en-us/find-a-cruise` — no bot wall across ~8 loads,
  though the site sets Akamai Bot Manager cookies (`_abck`, `bm_sz`, `ak_bmsc`).
- **Every available cruise ID:** `GET /orchestrator/cruise-query-processor/cruisesearch/cruiselist?sort=availableCruiseList&cabins=IFt7InBhcnR5IjoyfV0=`
  → `{ availableCruiseList: "M833,Q712B,…" }` — **590** IDs. (`cabins` is base64 of
  ` [{"party":2}]`.) Requests carry headers `brand: cunard`, `locale: en_US`, `country: CA`,
  `currency: CAD`.
- **Search pages:** `POST /orchestrator/cruise-query-processor/cruisesearch` with body
  `{ "filters": { "start": "10" }, "cabins": "<as above>", "availableCruiseList": "<all IDs>" }`
  → `{ results: 590, searchResults: [10 sailings], filterList }`. **Page size is fixed at 10**
  (`rows` and `pageSize` are ignored). Omitting `availableCruiseList` returns HTTP 500.
  Results arrive in departure order (the page's default sort, "Departure date - ascending").
- **A search result:** `cruiseId` ("M626C"), `itineraryId`, `name` ("Southampton To Hamburg,
  2 Nights"), `duration` (nights), `departDate`, `arrivalDate`, `destinationIds`
  (["Short-Break"]), `portOfCallIds` (["SOU","ATSEADAY","HAM"]), `shipId` ("QM"; `shipName`
  is empty), `embarkPortCode`, `disembarkPortCode`, `isSoldOut`, `minimumPrice` (504.74), and
  `cabins` — **one entry, the cheapest only**.
- **Details:** `GET /orchestrator/api/cruise/getCruiseDetails?ids=["M626C",…]&forceRCOne=true`
  (the page asks for 10 at a time) → `data.cruiseList.items[]` with `txName`, `overviewImage[0]._publishUrl`
  (2048×1536 JPEG), `embarkPortCode`/`disembarkPortCode` as `{ id, name }`
  ("Southampton (tours to London)"), `portsImage[]` (`{ id, txName }` per port), and
  `shipId.txName` ("Queen Anne").
- **Prices:** `GET /api/v2/price/cruise/M626C` → `data.currencyCode` "CAD" and
  `data.roomTypes[]`, each `{ id, name, lowestPrice: { price } }`. For M626C:
  BI Inside 504.74, BO Ocean View 586.81, BB Balcony 587.20, A Club Balcony 860.60,
  Q Queens Grills 1134.39, S Princess Grills 0. **The voyage page shows exactly these**
  ("Britannia Inside Staterooms from CA$504.74 per person"; CA$586, 587, 860, 1,134). A zero
  price means that cabin is not on offer.
- **Room-type codes** seen: `I`, `BI` (Inside), `O`, `BO` (Ocean View), `B`, `BB` (Balcony),
  `A` (Club Balcony), `S` (Princess Grill), `Q` (Queens Grill). The single-letter and `B…`
  codes appear on different ships.
- **Ships:** Queen Mary 2 (`QM`), Queen Anne (`QA`), Queen Victoria and Queen Elizabeth.
- **Segments:** a long voyage is also sold in parts, each its own cruise ID with its own dates,
  ports and price — M627 Hamburg → New York (10 nights), M627B Southampton → New York (7).
- **Destinations** (`filterList` counts, all years): Mediterranean 154, Transatlantic 95,
  Short-Break 60, World-Voyage 53, Caribbean 46, Canary-Islands 33, Usa-and-Canada 32,
  Norwegian-Fjords 31, Spain-France-And-Portugal 28, Northern-Europe 27, Asia 11,
  Panama-Canal-and-Central-America 9, Africa-and-Indian-Ocean 6, South-America 5; Alaska,
  Australia-and-New-Zealand, South-Pacific and Western-Europe 0. A sampled 10 Short-Break
  sailings were all 2–7 nights from Southampton to Hamburg, Rotterdam, Zeebrugge, Amsterdam,
  Cherbourg or Le Havre.

## Design

### 1. Fetching — `sites/cunard.js`

All requests are sent from inside one loaded `https://www.cunard.com/en-us/find-a-cruise`
page (`page.evaluate`), so they are same-origin and carry the site's cookies — as Viking does.
`politeDelay()` between every request.

1. **IDs:** `GET …/cruisesearch/cruiselist` → the `availableCruiseList` string.
2. **Search pages:** `POST …/cruisesearch` with `filters.start` = 0, 10, 20, … Stop at the
   first page whose sailings all depart after the window (or an empty page). Sailings departing
   from tomorrow to 12 months ahead are kept. If ordering cannot be relied on, the adapter
   still filters every row by date; stopping early is only an economy.
3. **Details:** one `getCruiseDetails` per search page, for that page's IDs.
4. **Prices:** one `GET /api/v2/price/cruise/<cruiseId>` per kept sailing.
5. `--limit N` caps the number of sailings priced, for dry runs.

Expected cost: ~30 search pages, ~30 details calls, ~300 price calls — ~9 minutes.

**Failure rules:**

- **IDs, a search page, or a details call fails** (HTTP ≥ 400, non-JSON, or JSON missing its
  expected array): the Cunard scrape throws, loudly, naming the request. Cunard keeps its
  previous sailings (`carryOver`), and the scrape exits 1.
- **A single price call fails:** the sailing is kept with the search's `minimumPrice` and
  its cheapest cabin, and `cabinPrices: null` (cards then read "Balcony price not listed", as
  for Princess). The scrape prints how many fell back. **If more than 10% of price calls
  fail**, the scrape treats it as a block: it throws, and Cunard carries over.
- **A bot wall** — HTML where JSON was expected, or HTTP 403 — throws `BotWallError`; the page
  is saved to `data/debug/` as for the other lines.

### 2. Parsing — one row per sailing

| Field | Source |
|---|---|
| `externalId` | `cruiseId` |
| `ship` | details `shipId.txName` |
| `departureDate` | `departDate` (date part) |
| `nights` | `duration` |
| `departurePort` / `endPort` | details `embarkPortCode.name` / `disembarkPortCode.name` |
| `ports` | `portOfCallIds` without `ATSEADAY`, consecutive repeats collapsed, first and last removed, each named from details `portsImage` (unnamed codes dropped) |
| `itinerary` | `name` with a trailing ", N Nights" removed |
| `destination` | `destinationIds` through the table in section 3 |
| `cabinPrices` | price answer's `roomTypes`, grouped: `I`/`BI` → interior, `O`/`BO` → oceanview, `B`/`BB`/`A` → balcony, `S`/`Q` → suite; cheapest per group; prices ≤ 0 dropped |
| `price` / `cabin` | the cheapest `cabinPrices` entry (or, on fallback, `minimumPrice` and its cabin's group) |
| `currency` | the price answer's `currencyCode` (CAD); `CAD` on fallback |
| `image` | details `overviewImage[0]._publishUrl` — at a smaller size if Cunard's image server offers one (checked in the plan) |
| `url` | `https://www.cunard.com/en-us/find-a-cruise/<itineraryId>/<cruiseId>` |
| `tripType` | `cruise` (the default) |

A sailing with no positive price — sold out — is skipped. An unrecognised room-type code is
ignored for `cabinPrices` and reported by the scrape.

### 3. Fitting into the app

**Destinations.** A sailing's `destinationIds` are mapped through this table; when it has
several, the most specific wins (any real region beats Short-Break).

| Cunard | Ours |
|---|---|
| Transatlantic | transatlantic |
| Mediterranean | mediterranean |
| Northern-Europe, Norwegian-Fjords | northern-europe |
| Caribbean | caribbean |
| Panama-Canal-and-Central-America | panama-canal |
| South-America | south-america |
| Asia | asia |
| World-Voyage | world |
| Usa-and-Canada | canada-new-england |
| Spain-France-And-Portugal, Canary-Islands | europe |
| Short-Break | europe |
| Africa-and-Indian-Ocean | **africa** (new) |
| Alaska | alaska |
| Australia-and-New-Zealand | australia-nz |

`normalize.js` gains the `africa` destination. Anything unmapped is reported by the scrape's
`unrecognised` list.

**Cabins:** interior, oceanview, balcony and suite are already canonical.
**Airports:** Southampton → LHR and New York → JFK exist; ports the table lacks are reported
as `airport: "…"` and added.

## Testing

Fixtures (real captures, 2026-10-14): one search page; its details answer; the M626C price
answer; one more price answer including a zero-priced cabin.

Unit tests, test-first: search page + details → rows; room types → `cabinPrices` (cheapest per
group, zeros dropped, unknown codes ignored); the 12-month window and the stop-early rule;
ports clean-up; itinerary name; the destination table, including Short-Break with a real region
and Africa; the price-call fallback; the 10% threshold; a bot wall; `africa` in normalize.

Live checks (Peter runs the commands): one sailing's prices against its voyage page; a dry run
with `--limit 20`; the full scrape with its real count — **if it is far above ~400 sailings,
stop and ask Peter** before going on.

## Order of work

On a new branch; each step its own commit.

1. Fixtures; parsing search pages + details into rows.
2. Price answers → `cabinPrices`, with the fallback.
3. Fetching, the window, registering the adapter.
4. Destinations (table, `africa`); airports for new ports.
5. Full scrape, checks, `CLAUDE.md` and `README.md`.

## Out of scope

- Ship descriptions.
- Sailings beyond 12 months.
- Cunard's flight-inclusive fares (`isFlightIncluded`) and promotions.
