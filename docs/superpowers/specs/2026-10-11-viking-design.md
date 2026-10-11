# Viking adapter (ocean) — design

**Date:** 2026-10-11
**Status:** approved 2026-10-11

## Purpose

Add Viking as the fifth cruise line: its **ocean** cruises, searchable alongside the other
four, with photos, ports, per-cabin prices and the flights panel. Prices are orientative,
like every price in this app.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope | Ocean only | Peter's choice. River and expedition cruises are different trips; out of scope. (Viking's two expedition ships, Octantis and Polaris, are therefore not included.) |
| Volume | Sailings departing in the next 12 months | Peter's choice. Matches what the flights panel can price (330 days); every itinerary still represented. One itinerary alone has 156 sailings over 2026–2029. |
| Price | The cheapest cabin still on offer, from the per-cabin list | The itinerary's headline `lowestPrice` can be stale: 14 Oct 2026 shows $5,999 while its only listed cabin, a suite, is $10,199 (the verandas are gone). On other dates `lowestPrice` equals the cheapest cabin and matches the site (Jan 12 2027 $4,199; Feb 3 2027 $3,899). |
| Air | Ignored | The second number on the pricing page (e.g. $1,299) is Viking's optional air package from Canadian gateways — not part of the cruise fare. |
| Currency | CAD, as served | viking.com and vikingcruises.com both redirect to vikingcruisescanada.com; every itinerary `Id` carries `CAD`. |
| Ship descriptions | None for now (`shipDescriptions = false`) | Not investigated; can be added later. |

## What the evidence shows (2026-10-11, read-only)

- **Search page** `https://www.vikingcruisescanada.com/oceans/search-cruises/index.html` is
  server-rendered (Knockout.js). No JSON request carries the results: they are embedded in a
  `<script>` as `window.app.superfac.viewModel = {…}` with `PageData.Value.Results` — **110
  itineraries**. `PageData.Value.CurrentPromoCode` is `"EBS"`.
- **An itinerary** (`Results[]`): `TcmId` (e.g. `iconic-western-mediterranean`),
  `VoyageName`, `Direction` ("Barcelona to Rome (Civitavecchia)"), `Days`, `PageUrl`
  (with `?startLocation=…&endLocation=…&year=…`), `Image` (already `wid=600`), `Cities`
  (ports in order), `Regions` (several, e.g. `["Europe","Mediterranean"]`),
  `Departures` (a range only, e.g. "Oct 2026 - Aug 2029"), `StartingPrice`.
- **Dated sailings:** `POST https://www.vikingcruisescanada.com/oceans/Core/DnPCruiseFullInfo?v=11`
  with `Content-Type: application/json`, `X-Requested-With: XMLHttpRequest`, body
  `{ "cruiseId": <TcmId>, "parameters": <PageUrl's query string>, "offerCode": "EBS" }`.
  The answer (~250 KB) has `cruises[]` — **every** sailing of that itinerary, all years.
- **A sailing** (`cruises[]`): `DepartureDateString` ("20270203"), `PackageCode`
  ("OVS270203"), `Ship` code and `shipType` ("Viking Vesta"), `cruiseDirection`,
  `soldOut`, `lowestPrice`, and `stateroomSummary[]` — `{ typeName: "veranda"|"suite",
  availability, lowestCruisePrice }`.
- **Ships:** the sampled itinerary sails on 14 ships (Viking Astrea, Jupiter, Libra, Lyra,
  Mars, Mira, Neptune, Saturn, Sea, Sky, Star, Vega, Vela, Vesta). Only verandas and suites.
- **River + Ocean Combinations:** 3 of the 110 (Iberian Odyssey; Rhine & Viking Shores &
  Fjords; Grand European & Viking Fjords) — part river.
- No bot wall seen across 5 page loads.

## Design

### 1. The adapter — `sites/viking.js`

- **Fetch:** load the search page; read the embedded `Results`. For each itinerary, POST
  its Dates & Pricing request — sequential, `politeDelay()` between, ~110 requests. Keep
  only sailings departing from tomorrow to 12 months ahead. `--limit N` caps itineraries
  fetched, for dry runs.
- **Parse** — one row per sailing:
  - `externalId`: `PackageCode`.
  - `ship`: `shipType`. `departurePort` / `endPort`: `Direction` split on " to ".
  - `departureDate` from `DepartureDateString`; `nights`: `Days − 1`.
  - `cabinPrices`: `{ [typeName]: lowestCruisePrice }` from `stateroomSummary`, positive
    prices only; `price`/`cabin`: the cheapest entry; currency CAD. A sailing with no
    priced cabin is skipped.
  - `destination`: the most specific of the itinerary's `Regions` that maps (section 2).
  - `itinerary`: `VoyageName`; `image`: `Image`; `ports`: `Cities` without the first and last.
  - `url`: site origin + the itinerary's `PageUrl` with `index.html` → `pricing.html`.
- Itineraries tagged "River + Ocean Combinations" are skipped.

### 2. Fitting into the app

- **Cabins:** `veranda` (already a balcony alias) and `suite` map with no change.
- **Destinations:** Viking region → ours, most specific first: Mediterranean →
  mediterranean, Scandinavia → northern-europe, British Isles & Ireland → british-isles,
  Alaska → alaska, Hawaii → hawaii, Caribbean & Central America → caribbean, Asia → asia,
  Australia & New Zealand → australia-nz, South America → south-america, North America →
  canada-new-england, Africa & Middle East / Northern Africa & Middle East / Sub-Saharan
  Africa → (new) africa-middle-east, The Arctic → northern-europe, Grand Journeys / World
  Cruises → world, Europe → europe. Exact mapping finalised against the 110 itineraries
  in the plan; anything unmapped is reported by the scrape.
- **Airports:** ports the table lacks are reported as `airport: "…"` and added, as before.
- **Trip type:** `cruise`.

## Testing

Fixtures (real captures): the ocean search page; the Iconic Western Mediterranean pricing
answer (captured 2026-10-11); one more pricing answer including a sold-out cabin.

Unit tests, test-first: extracting `Results` from the page; `Direction` → start/end;
the price rule (cheapest available cabin, not the stale `lowestPrice`); `cabinPrices`;
the 12-month window; region mapping; skipping river + ocean combinations; ship name.

Live checks: one sailing's price against its Dates & Pricing page; a dry run of 3
itineraries; the full scrape with its real count — **if it is far above ~1,500 sailings,
stop and ask Peter** before going on.

## Order of work

Each step is its own commit.

1. Fixtures; extracting itineraries from the search page.
2. Pricing answers → sailings.
3. Fetching; registering the adapter.
4. Regions; airports for new ports.
5. Full scrape, checks, `CLAUDE.md`.

## Out of scope

- River and expedition cruises.
- Viking's air packages and land extensions.
- Ship descriptions.
