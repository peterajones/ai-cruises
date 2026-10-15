# Full catalogues and a rolling 12 months — design

**Date:** 2026-10-15
**Status:** draft for review

## Purpose

Royal Caribbean and Celebrity have shown a thin, shifting slice of what they sell: 184 and
114 sailings, nearly all Bahamas and Caribbean, every Royal Caribbean card the same CocoCay
photo, and Celebrity's Alaska sailings gone between two scrapes (36 on 2026-10-02, none on
2026-10-07). Read their whole catalogues instead. At the same time, give every line the
same horizon: sailings departing in the next 12 months, rolling forward with each scrape.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Coverage | Royal Caribbean and Celebrity read their whole catalogue | The spike (below): the slice was ours, not theirs. |
| How | Capture the search request the page sends, replay it from inside the page with bigger pages | No copy of their 6 KB GraphQL query lives in our code: if they change it, we replay the new one. Same-origin, as Cunard's requests are. |
| Horizon | A rolling 12 months for **all six** lines: departing after today, up to 365 days ahead | Peter's choice. Already Cunard's and Viking's rule. A consistent "what can I plan in the next year". |
| Princess, Holland America | Trimmed to the window too | Peter confirmed: Princess drops ~97 of 195 (those after a year out); Holland America ~76 of 760 (its 2028 season). All of the 2027 Alaska season stays. |
| Galápagos | Its own destination, `galapagos` | Peter's choice. People ask for it by name; folded into South America, "Galápagos cruise" would return every South America sailing. As Cunard's `africa` was added. |

## What the spike showed (2026-10-15, read-only)

- **Both lines' `/cruises` page sends** `POST /cruises/graph`, query `CruisesSearchResults`,
  variables `{ filters, sort: { by: 'RECOMMENDED' }, pagination: { count: 10, skip: 0 },
  enableNewCasinoExperience: true }`, with headers `brand` (R / C), `country`, `currency`,
  `office`, `language`, `apollographql-client-name`, `apollographql-query-name`, `x-session-id`.
  Celebrity's `filters` is `voyageType:OCEAN` (its river cruises excluded); Royal Caribbean's
  is empty. The answer's `results` carries `cruises` and `total`.
- **The adapters keep the page's own first answer: 10 cruises.** Those are the 184 and 114.
- **The same request takes `count: 500` and a `skip`, sent from inside the page:**

  | | `total` cruises | Requests at 500 | Sailings parsed | In the next 12 months |
  |---|---|---|---|---|
  | Royal Caribbean | 1,188 | 3 (1.1–3.9 s each, up to ~7.8 MB) | 3,556 | **2,079** |
  | Celebrity | 638 | 2 | 1,894 | **838** |

- **The existing `parseListing` handles these answers unchanged**, through `normalizeAll`:
  every sailing priced per cabin; Royal Caribbean 88 distinct photos in the window (was 2),
  Celebrity 219. Royal Caribbean's window: Caribbean 793, Bahamas 404, Alaska 264, Europe 189,
  Mexico 164, Asia 149, Australia & NZ 49, Bermuda 31, … Celebrity's: Alaska 246, Caribbean
  173, Europe 149, Galápagos ~110, Bahamas 69, Asia 35, …
- **Unrecognised in the full catalogues:**
  - Ports with no airport: Tampa, Galveston, New Orleans, Baltimore, Cape Liberty, Shanghai
    (Baoshan), Seoul (Incheon), Colón, Cartagena, Valparaíso, Baltra Island.
  - Destination labels: Galapagos (336 sailings, all Celebrity), Transpacific (17),
    Repositioning (13), Pacific Northwest (3).
- No bot wall on any of the spike's page loads and replays (about a dozen, both sites).

## Design

### 1. Royal Caribbean and Celebrity — `fetchListingPages`

Each adapter, independently (the two files stay near-duplicates, as the project prefers):

1. Listen for the page's own `cruises/graph` request whose body names `CruisesSearchResults`;
   keep its URL path, headers (less browser-set ones: `:`-pseudo, `sec-*`, `user-agent`,
   `accept-encoding`, `content-length`, `origin`, `priority`, `referer`, `cookie`) and body.
2. Load `/cruises` as now; check for a bot wall as now.
3. Replay the captured body from inside the page with
   `pagination: { count: PAGE_SIZE (500), skip }`, every other variable unchanged, `skip` rising
   by 500 until a page has no cruises or `skip >= total`. `politeDelay()` between requests.
   Report progress (`page 2/3`) through `onProgress`.
4. Return the payload texts; `parseListing` is unchanged.

**Fails loudly** (the line then keeps its previous sailings, via the existing carry-over):
no captured request after the page loads; a replay with HTTP ≥ 400, or not JSON, or GraphQL
`errors`, or no `results.cruises` array; HTML where JSON was expected is a `BotWallError`.
A safety stop at 20 pages (10,000 cruises) guards against a `total` that never arrives.

The `limit` option keeps working: stop once `limit` sailings are parsed.

### 2. A rolling 12 months — every adapter

`inWindow(date, today)`: `date > today && date <= today + 365 days` (Cunard's rule, copied into
each adapter that lacks it — no shared module, as the adapters are kept independent).
`today` is the local date and injectable for tests.

- **Royal Caribbean, Celebrity:** `parseListing(payload, { today })` drops sailings outside the
  window. (Filtering after the fetch, not in the request: the whole catalogue is 2–3 requests.)
- **Princess:** `parseListing` drops sailings outside the window.
- **Holland America:** `parseListing` drops sailings outside the window. The 750 cap stays.
- **Viking, Cunard:** unchanged.

The dry-run sample and golden first-row tests pin `today` so fixtures don't age out.

### 3. Labels and airports

- **`normalize.js`:** new destination `galapagos` (`galapagos`, `galápagos`); new destination
  `transpacific` (`transpacific`, `trans pacific`), beside `transatlantic`; `pacific northwest`
  → `pacific-coast`. **Repositioning:** no alias — `findDestination` on the itinerary name
  finds a region when one is named; otherwise it stays on the scrape's to-do list rather than
  a guess.
- **`airports.js`:** TPA Tampa, IAH Galveston (Houston), MSY New Orleans, BWI Baltimore,
  EWR Cape Liberty (Bayonne), PVG Shanghai (Baoshan), ICN Seoul (Incheon), PTY Colón, CTG
  Cartagena, SCL Valparaíso (Santiago), GPS Baltra Island; and whatever else the first full
  scrape lists.
- The page's destination list, the search vocabulary and the flights panel take new
  destinations and airports from the data; nothing else changes.

### 4. What changes for Peter

~4,400 sailings instead of 1,856: Royal Caribbean ~2,079, Celebrity ~838, Princess ~98,
Holland America ~684, Viking ~326, Cunard ~276. Royal Caribbean and Celebrity add Alaska,
Europe, Mexico, Asia and more; Royal Caribbean's cards get varied photos. Lazy loading
already handles this size (measured at 1,857: ~25 ms per batch). `/api/dataset` grows from
~2 MB to ~5 MB — served locally.

## Testing

Test-first, `node --test`, no network:

- **Fetch loops** (Royal Caribbean, Celebrity) with a fake page, as Cunard's: captures the
  page's request and replays it with `count: 500`; pages until empty / `total`; keeps the
  captured filters (Celebrity's `voyageType:OCEAN`); fails on no captured request, HTTP 500,
  non-JSON, GraphQL `errors`, missing `cruises`; HTML is a bot wall; `limit` stops early;
  progress reported.
- **Window** for each of the four lines: a sailing today, tomorrow, at +365 and +366 days.
- **Labels and airports:** each new alias and port.
- **Fixtures:** a real captured 500-cruise answer for each line, trimmed to a few cruises
  (synthetic data stays inline in tests, per the project rule). Golden first rows updated.
- **Live:** `node scrape.js --site royal-caribbean --dry-run` and `--site celebrity
  --dry-run`, checking counts against the spike; then Peter's full scrape and a look at the
  page (Alaska from Royal Caribbean, varied photos, Galápagos in the destination list).

## Order of work

On a new branch; each step its own commit.

1. Royal Caribbean: replay fetch, window.
2. Celebrity: the same.
3. Princess and Holland America: window.
4. Labels and airports (after a dry-run lists what's still unrecognised).
5. Docs: `CLAUDE.md` (status counts, the Celebrity/Royal Caribbean coverage note, the window).

## Out of scope

- Celebrity's river cruises (`voyageType:RIVER`, 179 sailings).
- Ship descriptions beyond what each adapter already fetches.
- A horizon other than 12 months; making it configurable.
