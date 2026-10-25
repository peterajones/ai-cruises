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
  `sites/holland-america.js`, `sites/viking.js`, `sites/cunard.js` — one file per site, each knowing only its own site.
  Deliberately near-duplicates rather than a shared parser: when one site changes shape,
  the others keep running.
- `search.js` / `brain.js` / `server.js` / `public/` — the search layer over the scraped data.
  `brain.js` is the only file that calls a model.
- `normalize.js` — canonicalize destination/cabin labels via `DESTINATIONS` and `CABINS` mappings,
  enforce required fields, flag unrecognised values.
- `values.js` — derive the enumeration of every unique destination/cabin/port/nights/price
  across the dataset.
- `persist.js` — write atomically to `data/sailings.json` (write to temp file, move on success).
- `selections.js` — viewed and rated sailings in `data/selections.db` (`node:sqlite`); the only
  file that touches the database.

**Rule of thumb:** if you can specify the rule, write the rule. Field validation, normalization,
and enumeration are conditionals, not model calls. The model belongs only in the search layer
(that piece is not in this scraper).

## Running it

```bash
npm test                                  # unit tests, no network
node scrape.js --limit 5 --dry-run        # smoke test, writes nothing
node scrape.js                            # real run, writes data/sailings.json
npm run export-selections                 # a readable JSON copy of your ratings
npm run upload-data                       # send data/sailings.json to the server (-- --force)
npm run pull-ratings                      # copy the server's ratings down to this Mac
npm run push-ratings                      # move this Mac's ratings up, once (-- --force)
npm run hash-password                     # asks twice, prints LOGIN_PASSWORD_HASH
npm run make-key                          # prints a 32+ character key (JWT_SECRET, SYNC_KEY)
npm run local:start                       # Caddy + the stand-in server at https://ai-cruises.localhost:8443; Ctrl-C stops both
npm run local:upload                      # send data/sailings.json to the stand-in
npm run local:stop                        # stop Caddy if it was left running
npm run serve:local-sync                  # the Mac copy, syncing with the stand-in (Refresh button shows)
```

Fixtures in `test/fixtures/` are real captured payloads. When a site changes shape,
re-capture with `node tools/capture-fixture.js` and update the golden first-row files.
Synthetic test data belongs inline in test files, never in `test/fixtures/`.

A scrape prints each line's start, a running count for the slow ones (Princess, Holland America,
Viking, Cunard — rewritten in place in a terminal, every 15 s into a log), each line's time, and
"Done in m:ss". Adapters report through `onProgress(text)`; only `progress.js` prints. A full run is
~15–20 minutes, Cunard ~9 of them.

**`--site` refreshes only the lines named.** `node scrape.js --site royal-caribbean` scrapes Royal
Caribbean and keeps every other line's sailings from the previous run ("not scraped — kept N"),
as a failed line's are. Before 2026-10-15 it wrote that one line alone and the rest were gone.

A scrape that yields zero parsed rows is treated as a failure and exits with code 1,
leaving the previous `data/sailings.json` untouched — a broken selector cannot overwrite
a good dataset.

## Environment

- Node 24.15+ (`.nvmrc`; `nvm use` in this folder — the nvm default on this machine is still 22).
  24.15 is where built-in `node:sqlite` became a release candidate; My cruises stores ratings
  with it. On Node 24 the test runner prints its summary as `ℹ tests N`, not `# tests N`.
  Dependencies: `puppeteer` (scraping) and `@anthropic-ai/sdk` (search). Nothing else.
- Ollama at `http://localhost:11434`, `qwen2.5-coder:latest` (7B) is the default.
  `qwen2.5-coder:1.5b-base` is a *base* model — not for chat or tool roles.
  `/api/chat` is POST-only; a 405 in the browser means it's running.
- `ANTHROPIC_API_KEY` lives in `.env` (gitignored) and is loaded natively by
  `node --env-file-if-exists=.env` — no `dotenv` dependency. `npm run serve` does this.
  The search layer uses `claude-haiku-4-5` (~$0.002/query). No `ant` CLI installed.
- Server runs on port 3030 (`PORT=3031` runs a second copy beside it, e.g. to check a change),
  listening on `127.0.0.1` only — this Mac, not the Wi-Fi. `HOST=0.0.0.0` for a container; any
  `HOST` other than localhost needs the login set up and working ratings, or the server refuses
  to start and says which is missing (see Deployment).
- `DATA_DIR` moves `sailings.json`, `sailings.previous.json`, `flights-cache.json` and the scrape's
  `runs/` away from `data/`. **Ratings do not follow it:** `selections.db` follows only
  `SELECTIONS_FILE` (default `data/selections.db`), so a second copy for checks needs both set to
  scratch, or it touches Peter's real ratings. `SCRAPE_PROGRESS_MS` sets how often a scrape prints its running count
  outside a terminal (default 15 s; Refresh passes 2000). `REFRESH_ARGS` replaces the arguments
  the Refresh button gives `scrape.js` — for checks only, e.g. `--limit 5 --dry-run`.
- `guard.js` stands in front of every `/api/` route: requests another site sent (including another
  app on localhost) get 403, writes that aren't JSON 415, bodies over 64 KB 413. Every route spends
  something — ratings, Anthropic credit, the SerpApi quota. Tools like `curl` send no browser
  headers and still get in, so a public deployment needs a login as well.
- `SERP_API_KEY` in `.env` is SerpApi's Google Flights API, for the flights panel. Free plan:
  250 searches a month. Results are cached in `data/flights-cache.json` (gitignored) for 3 days.
  Tests never call it; they use saved responses in `test/fixtures/serpapi-*.json`.

## Deployment

Live at **https://ai-cruises.peter-jones.org** (Hetzner, run by Coolify). Spec:
`docs/superpowers/specs/2026-10-16-deployment-design.md`. The server's address, the Coolify
application and every key live in `~/Projects/deployment-notes.md`, never in this repo — it is
public, and a ratings file or a key committed here is published.

**Two roles, one codebase.** Settings choose which.

- **The Mac** is the development copy and the only place that scrapes. No login. `SYNC_URL`
  (the site's address) and `SYNC_KEY` in `.env` turn on the **Refresh data** button: scrape with
  live progress, then upload `sailings.json` to the server and copy the server's ratings back.
- **The server** has the login, the `/api/sync/*` routes and no scraping — no Chromium in its
  image. The server's ratings are the real ones; the Mac's are a mirror.

| Setting | Mac (`.env`) | Server (Coolify) |
|---|---|---|
| `HOST` | unset (`127.0.0.1`) | `0.0.0.0` (the Dockerfile sets it) |
| `SYNC_URL` | `https://ai-cruises.peter-jones.org` | — |
| `SYNC_KEY` | the key | the same key (32+ characters) |
| `JWT_SECRET`, `LOGIN_PASSWORD_HASH` | — (no login) | set |
| `TRUST_PROXY` | — | `1` |
| `ANTHROPIC_API_KEY`, `SERP_API_KEY` | as now | set |

**Set `TRUST_PROXY=1` in Coolify, or the server won't start (and the login would lock Peter out).** Without it every visitor
shares the proxy's address, so 5 bad guesses from anyone lock everyone out, Peter included. A
second proxy in front (Cloudflare, say) does the same, because the server reads the *last*
`X-Forwarded-For` entry — the one the nearest proxy added; earlier entries can be forged.

**Refusing to start.** With a `HOST` other than localhost the server exits, naming the problem,
if `JWT_SECRET` is missing or under 32 characters, `LOGIN_PASSWORD_HASH` isn't a hash
`npm run hash-password` makes, `SYNC_KEY` is set but under 32 characters, `TRUST_PROXY` isn't exactly `1` or `0`, or the
ratings database won't open. On the Mac the app still runs without ratings and says why; on a server that would
fail silently.

**Refresh, upload, pull.** Refresh runs the full `node scrape.js` as a child process (one at a
time; the last 500 lines are kept), then uploads, then pulls ratings. Results stay visible while it
runs; "Show the new data" redraws when it ends. Nothing written (zero sailings, or stopped) means
no upload — "the server keeps its data". **Stop** sends SIGINT, then SIGKILL after 10 s, because
Puppeteer swallows SIGTERM. The upload is gzip over HTTPS, `Authorization: Bearer <SYNC_KEY>`,
20 MB compressed / 50 MB unpacked. It is **refused** when a sailing has no id, line or departure
date (a null included), or when it holds fewer than half the server's sailings — unless forced
(`npm run upload-data -- --force`). The old file is kept as `sailings.previous.json`. The ratings
push is refused when the server already has ratings, unless forced.

**The Mac is a mirror.** After a pull, the Mac's pages say "Ratings copied from the server at
14:05 — changes here aren't kept" whenever `SYNC_URL` is set. A pull replaces every row in one
transaction; ratings made on the Mac are lost at the next one.

**A pull refuses to wipe ratings that exist only on the Mac.** When the Mac has saved cruises
and either (a) it has never copied from or pushed to the server, or (b) the server sent none, the
pull changes nothing and says so: (a) "never copied from the server … Send them first with
`npm run push-ratings`", (b) "The server has no saved cruises but this Mac has N … If the server
lost its data, send yours with `npm run push-ratings -- --force`". `npm run pull-ratings -- --force`
skips both checks and replaces the Mac's rows. **First deploy: `npm run export-selections` (a
backup), then `npm run push-ratings`, before any pull or Refresh.** A successful push also marks
the Mac as matching the server, so after it every pull and Refresh works; (a) only bites when you
pull before you have ever pushed or pulled. A refused push marks nothing. A Mac with no ratings
may pull from an empty server.

**Login.** One user, one password (12+ characters; only its hash is stored). A cookie
(`HttpOnly; Secure; SameSite=Strict`, always `Secure`) holds an HS256 token good for 30 days.
**A new password, or a new `JWT_SECRET`, logs every device out.** Log out clears the cookie, but a
copied cookie stays valid for its 30 days unless one of those two changes. Five wrong passwords
(or wrong sync keys) per address per 15 minutes give a 429. An attempt is counted *before* the
password is checked, so slow request bodies can't slip past the limit. The count is in memory; a
restart resets it. There is deliberately no site-wide lockout — anyone could use it to lock Peter
out. Everything is locked except `/login`, its assets, `POST /api/login`, `/healthz`,
`/api/sync/*` (which has its own key), and the home-screen app's manifest and icons
(`/manifest.webmanifest`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`) — browsers
fetch the manifest without cookies, so behind the login the app would get no name or icon.

**Home-screen app.** Safari → Share → Add to Home Screen gives a "Cruises" icon (the ship on the
accent teal) that opens full screen. Every page carries the tags, login included. The icons were
made once from `favicon-dark-mode.png` with PIL: opaque (iOS paints transparency black), the ship
in the middle 60% so Android's round crop doesn't clip it.

**Security headers** on every response, including a CSP that allows scripts only from this
site's own files. **Never add an inline `<script>` or an `onclick=`** to a page: it won't run, and
`test/pages.test.js` fails. Both pages' code lives in `public/index.js` and `public/mine.js`.
HSTS is sent only when `HOST` is public and the request's host isn't localhost, so never on the Mac, including the Caddy copy on 3031.

**`/healthz`** needs no login. 200 `ok`; 200 `ok — no data yet` before the first upload; 503
`unhealthy` when the data or the ratings can't be read.

**Dockerfile:** Node 24.22 (pinned), no Chromium (`PUPPETEER_SKIP_DOWNLOAD`), runs as `node`.
Coolify's persistent storage is mounted at `/app/data` — `sailings.json`, the previous copy,
`selections.db`, and the flights cache that protects the SerpApi quota. **Only `selections.db` is
backed up** (since 2026-10-17): the box's nightly `backup-volumes.sh` captures it as component
`ai-cruises` at 03:52 UTC, and the weekly drill restores it and counts its rows. To put the ratings
back, follow "Putting ai-cruises' ratings back" in the backups-dashboard README. The Mac's copy
after each pull is the other copy; the sailings can be re-scraped, and the flights cache refills.

**Deploys** run on every push to `main` (a GitHub webhook to Coolify; set up 2026-10-17). Data never
goes that way: it's `npm run upload-data` or a Refresh.

**First-deploy pitfalls (2026-10-16), each cost a round trip:**

- **peter-jones.org's DNS is at Cloudflare, not Hover.** Hover is only the registrar; a record added
  there does nothing. The `ai-cruises` A record is in Cloudflare, **DNS only (grey cloud)**: an
  orange-cloud proxy would put Cloudflare's address last in `X-Forwarded-For`, and the login's
  per-address limit would then count every visitor as one. Cloudflare also has a catch-all record,
  so a name that "resolves" may still point at the wrong place: check it gives the server's address.
- **Coolify interpolates `$` in environment values** (it runs the app through Docker Compose).
  `LOGIN_PASSWORD_HASH` (`scrypt$32768$…`) must be marked **Is Literal**, or the server refuses to
  start with "not a hash from npm run hash-password".
- **A domain changed in Coolify applies only on the next deploy.** The first deploy came up on its
  `sslip.io` address alone, and the domain answered "no available server" until a redeploy.

**Local HTTPS.** A stand-in for the server runs on the Mac: `npm run serve:server` starts a copy
on port 3031 with the server's settings from `.env.server` (`PORT=3031`, `TRUST_PROXY=1`,
`DATA_DIR=server-data`, `SELECTIONS_FILE=server-data/selections.db`, `JWT_SECRET`,
`LOGIN_PASSWORD_HASH`, `SYNC_KEY`, and the two API keys), and Caddy in front serves it at
`https://ai-cruises.localhost:8443` (`tools/Caddyfile.local`). `.env.*` and `server-data/` are
gitignored, so neither the secrets nor its ratings can be committed; Peter's `data/` is untouched.
Caddy's certificate needs its root trusted once: `caddy start …` first, then `caddy trust` (asks for
the Mac's password) — without Caddy running it fails with "requesting CA info … connection refused".
The Mac's own copy (`npm run serve`, port 3030, `.env`) has no login and no `JWT_SECRET`.

## Status

**Six lines working**, each to the next 12 months (scraped 2026-10-15): Royal Caribbean (2,078),
Celebrity (831), Princess (98), Holland America (682), Viking (326), Cunard (276) — 4,291
sailings departing 2026-10-16 → 2027-10-15, every one with a trip type (544 cruisetours, all
Holland America) and a destination. All but
12 have an end port — those are long Princess itineraries whose cards stop short (see the flights
panel below) — and every departure and end port maps to an airport. 46 ships with descriptions,
cheapest prices $199–$30,155 USD (the top is Celebrity's 7-night Galápagos Outer Loop and Machu
Picchu) and $395–$80,999 CAD (a 28-night Viking voyage). Alaska: 1,213 sailings. 409 tests.

**Prices per cabin type.** Every sailing has `cabinPrices` — cabin type → that cabin's
cheapest price, e.g. `{ interior: 959, oceanview: 1009, balcony: 1459, suite: 2164 }` — and
`price`/`cabin` stay the cheapest overall. A cabin search means "offers this cabin", and a
price limit applies to that cabin's price, so "a balcony under $2,000" compares balconies.
`priceFor(sailing, cabin)` in `search.js` is the one rule: the server's search uses it, and
the page imports the same file (served at `/search.js`) for the Cabin dropdown, the price
slider, the sort and each card's headline price. Princess lists only its cheapest cabin, so
its `cabinPrices` is `null`: in a search for another cabin its cards say "Balcony price not
listed · from $… interior". Spec: `docs/superpowers/specs/2026-10-03-cabin-prices-design.md`.

**Flights panel.** Each card's "✈ Flights" opens a panel pricing the trip there and back
from a home airport (a box in the panel, remembered in the browser, default YYZ): out the day
before sailing, home on `endDate` (departure + nights). Every sailing has `endPort` — from the
disembark day (Royal Caribbean, Celebrity), `disembarkPortName` (Holland America), or "Roundtrip
from X" / the last listed port (Princess). `airports.js` maps port text to an airport by rules;
a port it doesn't know shows up in a scrape's `unrecognised` list as `airport: "…"` — add it
there. `flights.js` plans the search (round trip, multi-city for one-ways, one leg if you live
at a port), reduces Google Flights' answer, and caches it. A first-leg price is the whole
trip's price (spike, 2026-10-07), so one search per panel. No search beyond 330 days ahead —
airlines don't sell that far out. **Princess cards list only the first ports of a long
itinerary**, so a one-way card with 8+ ports has `endPort: null` and the panel prices only the
flight out, saying why (N731's card ends at Kotor; the cruise ends in Ravenna). Spec:
`docs/superpowers/specs/2026-10-07-flights-panel-design.md`.

**Viking quirks worth knowing** (spec: `docs/superpowers/specs/2026-10-11-viking-design.md`):

- **Ocean only.** River and expedition cruises (incl. the expedition ships Octantis and
  Polaris) are out; the 3 "River + Ocean Combinations" itineraries are skipped.
- **The itinerary list is embedded in the search page** (`window.app.superfac.viewModel`),
  not fetched. Each itinerary's dated sailings come from one `POST
  /oceans/Core/DnPCruiseFullInfo`, sent from inside the page so it is same-origin.
- **The next 10 sailings of each itinerary, within 12 months** (`MAX_SAILINGS_PER_ITINERARY`).
  Only 69 of 107 itineraries sail in that year, most just 1–4 times, so Viking is ~330 —
  not the ~3,700 the uncapped busiest routes suggested.
- **Price is the cheapest listed cabin, never the headline `lowestPrice`** — on 14 of 156
  sampled sailings the headline was below every listed cabin.
- **Verandas and suites only** (no interior or ocean view). **CAD**, as served: viking.com
  redirects to vikingcruisescanada.com.
- **Each sailing has its own direction.** An itinerary's sailings run both ways (Barcelona →
  Rome and Rome → Barcelona; 45 of 69 itineraries in the window), so start, end and port
  order come from the sailing's `cruiseDirection`, not the itinerary's. Directions read
  "X to Y" or "Roundtrip X". Port names carry accents (Reykjavík, Tromsø): `airports.js`
  folds them.
- **World voyages:** a world cruise, or a "Grand Journeys" voyage spanning 3+ regions or
  over 60 days, is filed under `world` — otherwise world cruises fell to "Hawaii".
- **Any failed pricing request fails the whole Viking scrape** (loudly, naming the
  itinerary). Like any failed line, Viking then keeps its sailings from the previous run
  (`carryOver` in persist.js), and the scrape exits 1.

**Cunard quirks worth knowing** (spec: `docs/superpowers/specs/2026-10-14-cunard-design.md`):

- **Sailings in the next 12 months**, all four Queens (Mary 2, Anne, Victoria, Elizabeth) —
  ~275 of the 590 Cunard lists.
- **Everything is requested from inside the find-a-cruise page** (same-origin): the cruise ID
  list, search pages, a details call per page, a price call per sailing. ~300 requests,
  ~9 minutes — the heaviest line. The site sets Akamai bot-manager cookies; none blocked us.
- **Search pages are fixed at 10** and must carry the full ID list (`availableCruiseList`) —
  HTTP 500 without it. Paging is `filters.start`.
- **The search carries only the cheapest cabin**, and its cabin filter changes *which*
  sailings come back, not the price. Per-cabin prices come only from
  `GET /api/v2/price/cruise/<id>`, one per sailing. A price of 0 means not on offer.
- **Two currency headers.** The search reads `currency`, the price API `currencycode` —
  without it, HTTP 412 "Currency Code Header is missing" (valid JSON, so it looks like an
  answer). Both are sent on every request.
- **A failed price call falls back** to the search's cheapest cabin (`cabinPrices: null`);
  **more than 10% failing fails the line** — that is a block or a changed API, not bad luck.
- **Room types come in two code styles** (BI/BO/BB on Queen Mary 2, I/O/B on Queen Anne);
  Club Balcony → balcony, Princess and Queens Grill → suite. An unknown code passes its name
  to normalize, which maps or reports it.
- **"Short Break" is a trip length, not a place:** → `europe`, unless the sailing also names a
  real region. **Africa & Indian Ocean** → `africa`, a destination added for Cunard.
- **Segments of long voyages are their own sailings** (M627 Hamburg → New York, and M627B
  Southampton → New York, the same voyage). CAD, as served. Photos `?imwidth=600`.

**Royal Caribbean and Celebrity read their whole catalogues** (spec:
`docs/superpowers/specs/2026-10-15-full-catalogues-design.md`). Their `/cruises` page asks for
its first 10 cruises; the adapters capture that `CruisesSearchResults` request and replay it from
inside the page with `pagination: { count: 3000 }` — the whole catalogue in one request (Royal
Caribbean ~1,190 cruises, 14 MB, ~9 s; Celebrity ~640, ocean only: the page's own
`voyageType:OCEAN` filter is kept). No copy of their GraphQL query lives in our code. **Not pages
of 500:** the site's order shifts between requests, and paging by `skip` returned 67 cruises twice
and missed 67 others; paging is kept only for a catalogue over 3,000 cruises, and a cruise that
comes back twice fails the fetch. Before 2026-10-15 they read the 10 cruises alone, and coverage
drifted: Celebrity's 36 Alaska sailings vanished between two scrapes.

**Every line keeps the next 12 months** — departing after today, up to 365 days ahead,
rolling forward with each scrape. One rule, `withinNextYear` in `scrape.js`, applied to each
line's fresh sailings and to any carried over ("left out N sailings outside the next 12 months").
Holland America's 750 cap still applies first. "Repositioning" sailings take their destination
from the itinerary name: a region it names, or one of the voyages Peter mapped by name (Caribbean
crossings like "Colon To San Juan Cruise"; Iceland/Greenland → transatlantic). A new one shows up
in the scrape's to-do list. **Antarctica is its own destination** (2026-10-17): an itinerary
that names Antarctica is filed under `antarctica` whatever the line's label — Celebrity labels its
Equinox voyages "South America", so a search for Antarctica found nothing. Only that name overrides
a label; letting any itinerary name win would refile hundreds.

**Cruisetours are a trip type.** Every sailing has `tripType`: `"cruise"` or
`"cruisetour"` (a cruise plus land days, sold as one package — only Holland America has
them). `normalize.js` defaults it to `"cruise"`, so adapters that sell only cruises never
set it. Search returns both unless asked; "Denali", "land tour" or "cruisetour" narrow to
cruisetours, "cruise only" excludes them. Cards are labelled "Cruisetour · includes land
days", because a cruisetour's `nights` is the whole package, land included.

**My cruises** (spec: `docs/superpowers/specs/2026-10-14-my-cruises-design.md`). Opening a
cruise's View ↗ or ✈ Flights records a view; cards and the ✈ panel carry 1–5 stars (click the
current star to clear). Every action can be undone on its own: the "Viewed ✕" tag clears a
cruise's views (an unrated one then leaves My cruises), and each `/mine` row has a two-click
"Remove" that forgets the cruise entirely. The "My cruises" chip shows everything viewed or rated — rated first,
then most recently viewed — and `/mine` is the same as a sortable table with price then and now.
Each row keeps a snapshot of the sailing, so a cruise that departs or leaves the scrape still
shows, greyed, "No longer listed". Search understands `minRating` ("my 5-star cruises"),
`hideRatedAtMost` ("hide the ones I rated 2 or less" — unrated stay) and `viewed` ("ones I
haven't seen"); "best-rated" is not the shopper's own rating and stays null. Ratings live only
in `data/selections.db` (gitignored) — `npm run export-selections` for a backup. If the database
can't open (Node < 24.15, a bad path), the app runs without ratings and says why.
`SELECTIONS_FILE=…` points a second copy at a scratch database; checks always use one.

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
- **A fresh tab per ship.** One tab reused for 17 results pages held 3.3 GB by the end
  (2026-10-16); a tab per ship, closed afterwards, peaks ~1.4 GB.
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
  shells.
- **The API returns only the fields you ask for** (`fl`), and has ~5,500 per sailing.
  Copying the site's own search query missed `cruiseOverviewImage` (the card photo,
  requested `?imwidth=600`: 43 KB instead of 190 KB) and `portImages` (the ports of call).
  Before concluding a field doesn't exist, ask for `fl=*` on one sailing.

**Cross-currency price searches get a notice, not a refusal.** `search.js` compares bare
numbers, so "under $800" across USD and CAD is approximate. `currencyNote()` returns the
results with a note saying so. It judges the candidates *before* the price filter — judging
the survivors would go quiet exactly when the comparison wrongly excluded every CAD sailing.

## To do

Nothing queued. Holland America's design and plan are in `docs/superpowers/specs/` and
`docs/superpowers/plans/` (2026-10-02).

## Open questions

Noted, not decided. Don't act on these without asking.

**Sticky year chips — done 2026-10-17.** The header is no longer pinned; the year row is. A spike
at 800×600 and 390×844 found the pinned header with its example chips took 37% and 34% of the
screen, and the year row scrolled away. Pinning the years under that header would have made it
worse (~45%), so the header scrolls away instead and the year row pins: 51px (9%) on the laptop,
102px (12%) on the phone, where ↑ Search shares My cruises' line. Once pinned, the row shows
"↑ Search", which scrolls to the top with the cursor in the box (an IntersectionObserver on the
header sets `#years.stuck`).

**Verify UI on a small viewport before judging it.** Peter works on a 27" Studio Display, where
vertical space is abundant and scroll-loss is felt differently than on a laptop or phone. Any
layout judgement made only at that size is suspect in both directions — problems can look worse
than they are, and real small-screen problems stay invisible. Check at ~800×600 before calling
a layout question settled.

**Lazy loading.** Cards are built 60 at a time as you scroll (`BATCH` in `public/index.html`) —
building all 1,857 took ~0.6 s on a desktop and ~2 s on a slowed phone on every filter or sort
change; now ~25 ms and ~85 ms (measured 2026-10-14). "Show all" builds the rest, e.g. for ⌘F.
Images carry `loading="lazy"`, so only those in view load. Celebrity, Holland America and
Cunard honour `?imwidth=600`. Royal Caribbean ignores it (and `?wid=`, and the `?$800x450$` its own
page sends): its photos are 2880px originals of 0.7–2.8 MB, so the adapter asks its image store
for the 1280px copy at `…jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg` (0.15–0.5 MB, all
19 photos in the fixture have one; checked 2026-10-15). Royal Caribbean's photos belong to the
itinerary; with the whole catalogue its cards show ~90 different ones (2 before 2026-10-15).
Nothing is downloaded locally — image URLs are hotlinked. A card with no photo — Celebrity lists
37 itineraries with none, most of them Galápagos — or whose photo fails to load says "Image not
available". **Checking photos headlessly:** Royal Caribbean, Celebrity and Cunard answer a
`HeadlessChrome` user agent with an HTML block page instead of the photo (Chrome reports
`ERR_BLOCKED_BY_ORB`); set a normal Chrome user agent in puppeteer, or every photo looks broken.

## Decided against

**Labelling Celebrity's land-tour packages as cruisetours** (2026-10-15). Some Celebrity
sailings include land days ("Galápagos Outer Loop and Machu Picchu", 7 nights, $30,155) but
show as plain cruises. Peter: the price makes a package obvious, and it is a booking-time
decision, not an exploring one. Not worth the effort.

## Working style

- Say what you're about to do, what Peter will run, and what success looks like —
  before doing it.
- Hand over the command and let him run it rather than reporting a summary of output.
- Build the smallest thing that *works* first; explore failure modes after.
- Never frame a failure as the intended outcome.
- Answer the question asked. Don't turn a question into a build session.
