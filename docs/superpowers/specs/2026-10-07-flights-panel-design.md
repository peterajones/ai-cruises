# Flights panel — design

**Date:** 2026-10-07
**Status:** approved 2026-10-07

## Purpose

Getting to the ship is part of what a cruise costs. Pick a cruise, open a panel, and see
roughly what flying there and back costs: from your home airport to the port the day
before sailing, and home from the port where the cruise ends, on the day it ends. Like
every price in this app it is orientative — "from about $543" — for planning and
inspiration, not booking. Success: on the Westerdam 7-Day Glacier Discovery Northbound
card (Vancouver → Whittier, 9–16 May 2027), the panel shows "Flights from about $543 ·
cruise + flights from about $1,312", the three cheapest options, and a link to the same
search on Google Flights.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Source | SerpApi's Google Flights API; key in `.env` as `SERP_API_KEY` | Spike, 2026-10-07: the only option with live fares, open sign-up and a usable free tier (250 searches/month). Amadeus Self-Service shut down 17 July 2026; Kiwi and Skyscanner are invite-only; Aviationstack and FlightAware AeroAPI return no fares. |
| Home airport | A box in the panel, remembered in the browser (`localStorage`), default YYZ | Peter's choice. Set once; changeable. |
| When to search | When the panel opens, then cached | Peter's choice. A search takes ~9 s; searches are spent only on cruises actually looked at. |
| What to show | Headline "from about", cruise + flights total, three cheapest options, a Google Flights link | Peter's choice. |
| Headline | The cheapest option returned, labelled "from about" | Nothing in one search says which options can be completed; in the spike the cheapest ($517) could not, the real cheapest was $543 — ~5% optimistic, acceptable for orientative prices. |
| Currency | The cruise's own currency, via SerpApi's `currency` | The cruise + flights total then never mixes currencies. No converter needed. (Peter's converter, peterjones.dev/projects/currency-converter, is the natural tool if cross-currency cruise comparison is ever wanted — out of scope here.) |

## What the evidence shows (spike, 2026-10-07)

- One multi-city search (YYZ → YVR 8 May 2027; ANC → YYZ 16 May 2027, USD): HTTP 200 in
  9.3 s, 24 options, ~40 KB. Response keys: `best_flights`, `other_flights`, `airports`,
  `search_metadata` (with `google_flights_url` — the same search on Google Flights).
- **A first-leg option's `price` is the whole trip's price.** Following the Air Canada $543
  first leg's `departure_token` gave return options from exactly $543 (Alaska via Seattle).
- The cheapest first leg (Flair, $517) returned no return options at all.
- No `price_insights` on multi-city searches.
- Each option: `price`, `total_duration` (minutes), `flights[]` (each with
  `departure_airport.{id,time}`, `arrival_airport`, `airline`, `duration`), `layovers`.
- The saved response contains no API key (`search_parameters` omits it).

## Design

### 1. The data a search needs

- **`endPort`** on every sailing, supplied by each adapter:
  - Royal Caribbean, Celebrity: the port of the itinerary day whose activity is `DEBARK`.
  - Holland America: `disembarkPortName` (added to the request's `fl`), name half of `#@#`.
  - Princess: the departure port when the card says "Roundtrip from X"; otherwise the
    last listed port.
- **`endDate`**, computed in `normalize.js`: `departureDate` + `nights`. (Holds for
  cruisetours: the 14-day Denali tour runs 9 → 23 May.)
- **`airports.js`** — port text → IATA airport code, by rules: a known place name found
  inside the port text, longest match winning, as `findDestination` does. Spelling variants
  share an entry ("Fort Lauderdale", "Ft. Lauderdale, Florida" → FLL; "Orlando (Port
  Canaveral)", "Port Canaveral (Orlando)" → MCO). Ports naming a nearby city map to its
  airport (Whittier → ANC, Civitavecchia → FCO, Southampton → LHR). Covers all 37 current
  departure ports and every end port in the data. Unknown → `null`, reported in the scrape's
  `unrecognised` list.
- **Flight dates:** out on `departureDate` − 1 day; home on `endDate`.
- **Search type:** round trip (`type=1`) when start and end airports are the same;
  otherwise multi-city (`type=3`, `multi_city_json`).

### 2. The server

- **`GET /api/flights?id=<sailing id>&home=<IATA>`** returns:
  `{ route: { home, outbound: {from, to, date}, inbound: {from, to, date} }, currency,
  fromPrice, options: [{ price, airlines, departs, stops, minutes }] (3 cheapest),
  googleFlightsUrl, fetchedAt }`, or `{ reason, message }` for each case in section 4.
- **`flights.js`** — builds the SerpApi request, calls it with a 30 s timeout, and reduces
  the response to that summary. No model call.
- **Cache:** `data/flights-cache.json` (gitignored), keyed by home, start and end airports,
  both dates and currency. An entry is reused for **3 days**, then re-searched. Written
  atomically (temp file, then rename), as `persist.js` writes the sailings. Survives
  restarts.
- The key is read from `SERP_API_KEY`; it never reaches the browser or a log line.

### 3. The panel (`public/index.html`)

- A **"✈ Flights"** button on each card, beside "View ↗", opens a panel from the right
  (full width on a phone). Closes with ✕, Esc, or a click outside.
- Top to bottom: the cruise's title, ship and dates; **"Flying from: [YYZ]"**; the two
  flights in words (*Toronto (YYZ) → Vancouver (YVR) · Sat 8 May*); then "Searching
  flights… (about 10 seconds)" until the result: **"Flights from about $543"**, **"Cruise +
  flights from about $1,312"**, the three cheapest options, **"See all on Google Flights
  ↗"**, and *"checked 2 days ago"* for a cached result.
- The cruise part of the total is the card's headline price (`shownPrice`), so a balcony
  search totals with the balcony price. A Princess "not listed" card totals with its
  cheapest price and says so.
- All text set with `textContent`, as the cards are.

### 4. When things go wrong

Each case shows a plain message; none but the last two spends a search.

| Case | Message |
|---|---|
| No airport for a port | "No airport known for Whittier yet" |
| Outbound date more than **330 days** away | "Airfares aren't published this far ahead yet" |
| Home airport not three letters | caught in the box before any request |
| No `SERP_API_KEY` | "Flight search isn't set up: add SERP_API_KEY to .env" |
| No flights found | "No flights found for these dates", with the Google Flights link |
| Quota used up, or SerpApi slow / down | SerpApi's own error, or "Couldn't reach the flight search" after 30 s |

## Testing

Unit tests, test-first:

- `airports.js` against every departure and end port in the current data, plus the
  spelling-variant and nearby-city cases.
- Each adapter's `endPort` from its captured fixture; `endDate` in `normalize.js`.
- `flights.js`: request building (round trip vs multi-city, dates, currency, the 330-day
  rule) and response reduction against the spike's real multi-city response, saved as
  `test/fixtures/serpapi-multicity.json`. One round-trip response is captured the same way
  (1 search) for the round-trip path.
- The cache: hit, expired, miss.

Live check: open the Westerdam panel — first time ~9 s and 1 search; second time instant
and none.

## Order of work

Each step is its own commit.

1. `airports.js`.
2. `endPort` in the adapters, `endDate` in `normalize.js`.
3. `flights.js`, with the fixtures.
4. The cache and `/api/flights`.
5. The panel.
6. Full scrape, live check, `CLAUDE.md`.

## Out of scope

- Converting prices between currencies.
- Hotels the night before sailing.
- Booking, or choosing specific flights.
- More than one traveller (prices are per person, like the cruises').
