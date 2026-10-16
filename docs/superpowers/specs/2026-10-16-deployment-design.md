# Deployment, login and a Refresh button — design

**Date:** 2026-10-16
**Status:** approved 2026-10-16

## Purpose

Put ai-cruises on Peter's Hetzner/Coolify server at **ai-cruises.peter-jones.org**, behind a
login, so he can explore and rate cruises from any device. The scraping stays on his Mac: a
"Refresh data" button there runs the scrape, shows its progress, uploads the new
`sailings.json` to the server and copies the server's ratings back.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where scraping runs | **Peter's Mac** | Peter's idea. The spike (below) proved the server *can* scrape, but at 1.4 GB per run on a shared 4 GB box, with a 1.4 GB image. From the Mac: no Chromium on the server, a small image, and the home address every line is known to accept. |
| How new data reaches the server | **Direct HTTPS upload** with a shared key, no git, no redeploy | Committing a 4.6 MB file per refresh grows the repo forever; a redeploy rebuilds the app to change one data file; an automatic push would break the "Peter pushes" rule. The server already reloads `sailings.json` when it changes (`loadDataset`). |
| Which copy is the real one | **The server** | Peter's choice. The Mac becomes the development copy and a mirror. |
| Ratings on the Mac | **One-way pull from the server**, with a note | Peter chose (a): "Ratings copied from the server at 14:05 — changes here aren't kept". Not via GitHub: the repo is **public**, and the ratings would be published. |
| Login | **Trimmed MyFinancesWeb design, no new dependencies** | One user, password hash in a setting, HS256 JWT in a cookie, signed with `node:crypto`; plus security headers and "a new password ends every session" so it is at least as secure as MyFinancesWeb. |
| Container | **A Dockerfile in the repo**, Node 24.22 pinned, no Chromium | Pins Node (the old-Node problem), skips puppeteer's Chrome download. Same build type as peterjonesdev2027. |
| Results during a refresh | **Stay visible** | Peter's choice. The data stays valid until the new file is swapped in. |
| Subdomain | **ai-cruises.peter-jones.org** | Peter's choice. DNS at Hover. |

## What the spike showed (2026-10-16, throwaway, nothing committed)

A full `node scrape.js --dry-run` in a Node 24 + Debian Chromium container:

| | Container on the Mac | Container on the Hetzner box (cpx21, Ashburn) |
|---|---|---|
| Royal Caribbean | 2,081 | 2,079 |
| Celebrity | 841 | 841 |
| Princess | failed at a 1.5 GB cap; 95 alone (peak **3.3 GB**); 95 with a fresh tab per ship (peak 1.4 GB) | 95 (fresh tab per ship) |
| Holland America | 687 | 687 |
| Viking | 322 | 322 |
| Cunard | 278 | 276 |
| Time | 25:06 | 26:45 |
| Peak memory | 1.5 GB (cap) | 1.43 GB of a 1.6 GB cap; other apps never below 781 MB available |
| Image | 995 MB (arm64) | 1.4 GB (amd64) |

- **No line blocked the datacentre address**, Cunard's Akamai included. One ship page (Celebrity
  Ascent) timed out once.
- **Princess reuses one tab for 17 heavy results pages and its memory piles up** — 3.3 GB, against
  300–700 MB for every other line. Blocking photos did not help (the first page alone is 1.4 GB, and
  never finished loading); **a fresh tab per ship, closed afterwards, brought it to 1.4 GB** with the
  same 95 sailings. Worth having on the Mac too — part 1 below.
- The server box has 3.8 GB, ~2.2 GB available, no swap.

Kept here for the day scraping might move to the server; not used by this design.

## Design

### Two roles, one codebase

```text
Peter's Mac (development copy, no login)           Hetzner (ai-cruises.peter-jones.org, login)
────────────────────────────────────────           ───────────────────────────────────────────
[Refresh data] ─▶ scrape (as now, ~25 min)
                  └─▶ data/sailings.json ──upload (SYNC_KEY)──▶ data/sailings.json  (volume)
                                                               reloaded on the next request
data/selections.db ◀──── pull ratings (SYNC_KEY) ──────────── data/selections.db   (volume)
  "Ratings copied from the server at 14:05 —                   ← Peter rates here, any device
   changes here aren't kept"
```

Code goes Peter's push → GitHub → Coolify redeploy. Data goes Mac → server directly.

Settings choose the role:

| Setting | Mac (`.env`) | Server (Coolify) |
|---|---|---|
| `HOST` | unset (`127.0.0.1`) | `0.0.0.0` (in the Dockerfile) |
| `SYNC_URL` | `https://ai-cruises.peter-jones.org` | — |
| `SYNC_KEY` | the key | the same key |
| `JWT_SECRET`, `LOGIN_PASSWORD_HASH` | — (no login) | set |
| `TRUST_PROXY` | — | `1` |
| `ANTHROPIC_API_KEY`, `SERP_API_KEY` | as now | set |

**Refusing to start.** When `HOST` is anything but `127.0.0.1`/`localhost`, the server refuses to
start, naming the problem, if:

- `JWT_SECRET` is missing or under 32 characters;
- `LOGIN_PASSWORD_HASH` is missing or not a hash `npm run hash-password` makes;
- `SYNC_KEY` is set but under 32 characters;
- the ratings database cannot open (old Node, unwritable volume). On the Mac the app still runs
  without ratings and says why, as now; on a server that would fail silently.

### Part 1 — Princess: a fresh tab per ship

`fetchListingPages` in `sites/princess.js` opens a new tab for each ship (same user agent and
viewport as `newPage`), loads and scrolls it as now, and closes it in a `finally`. The spike's
change, made properly and tested with a fake browser: one tab per ship, each closed, even when a
page throws.

### Part 2 — The Refresh button and progress panel (Mac)

- **Button** "Refresh data" at the left of `#results-bar`. Shown only when `GET /api/refresh`
  reports `available: true`, i.e. `SYNC_URL` and `SYNC_KEY` are set. Never on the server.
- **`POST /api/refresh`** starts `node scrape.js` as a child process (the full scrape, no flags)
  and answers at once. One at a time: while one runs, a POST returns the running one (no second
  scrape).
- **`GET /api/refresh`** returns `{ available, state, startedAt, lines, result }`;
  `state` is `idle | running | uploading | pulling | done | failed | stopped`. The page polls it
  every 2 s while the panel is open. The last 500 output lines are kept in memory.
- **Progress interval.** Outside a terminal `progress.js` prints at most every 15 s. A new
  `SCRAPE_PROGRESS_MS` setting lowers it; the refresh passes `2000`.
- **Panel** below the button: the scrape's own lines, newest at the bottom, scrolling. **Hide**
  closes the panel (the scrape continues); **Stop** ends the child process — nothing is written,
  since the scrape writes only at its end.
- **Results stay visible.** On completion the panel offers **Show the new data**, which re-fetches
  `/api/dataset` and redraws, rather than swapping the grid unasked.
- **Reload or close the tab:** the scrape continues; reopening shows the panel with the run.
  **Stopping the local server** stops the scrape; the next page load shows `idle`.
- **Endings:**
  - Success: "Done in 24:12 — 4,300 sailings · uploaded to the server ✓ · ratings copied from
    the server ✓". Upload and pull run automatically (part 3).
  - A line failed (exit 1, file written): the same, plus the failures as the scrape printed them
    ("princess: kept 98 sailings from the previous run"). Still uploaded.
  - Nothing written (zero sailings, or stopped): "Nothing changed — the server keeps its data". No
    upload. "Written" is judged by `data/sailings.json`'s modification time, before and after.
  - Upload or pull failed: the reason, and **Try again** for that step alone.
- Behind `guard.js`, like every `/api/` route.

### Part 3 — Upload and ratings pull

**Client:** new `sync.js` with `uploadSailings({ force })`, `pullRatings()` and `pushRatings({ force })`.
Commands: `npm run upload-data [-- --force]`, `npm run pull-ratings`, `npm run push-ratings [-- --force]`.
`SYNC_URL` must be `https://`, except `http://localhost`/`127.0.0.1` (checks).

**Key:** `SYNC_KEY`, ≥ 32 characters (`npm run make-key` prints one), sent as
`Authorization: Bearer …`, compared with `timingSafeEqual` on SHA-256 digests (equal length
regardless of input). Wrong keys count toward the login's per-address limit (part 4).

**`PUT /api/sync/sailings`** — the body is `sailings.json`, gzip-compressed
(`content-encoding: gzip`, `content-type: application/json`).

- Limits for this route alone: 20 MB compressed, 50 MB decompressed (streamed, stopped at the
  limit — no zip bomb). Every other route keeps `guard.js`'s 64 KB.
- Refused, with the server's data unchanged, if: not JSON; `sailings` is missing or empty; a
  sailing lacks `id`, `line` or `departureDate`; or **it has fewer than half the server's current
  sailings** (unless `?force=1`).
- Written to a temp file and renamed over `data/sailings.json`; the previous file is renamed to
  `data/sailings.previous.json` first. The existing reload serves it on the next request.
- Answers `{ stored: 4300, was: 4291 }`.

**`GET /api/sync/selections`** — every row of the ratings database, all columns, as JSON (the
export format, extended if it lacks any column).

**`PUT /api/sync/selections`** — the same JSON, replacing all rows. **Refused if the server already
has any rows**, unless `?force=1`. Used once, to move the Mac's ratings to the server, and for
restoring a backup.

**Applying a pull on the Mac:** all rows replaced in one transaction (`selections.js` gains
`replaceAll(rows)`), so a failure leaves the old rows. Not a file swap: the Mac's server holds the
database open. The pull time is stored in the database (a one-row `meta` table) and the Mac's
pages show **"Ratings copied from the server at 14:05 — changes here aren't kept"** whenever
`SYNC_URL` is set.

### Part 4 — Login

**Settings:** `JWT_SECRET` (≥ 32 characters); `LOGIN_PASSWORD_HASH`, from
`npm run hash-password` — asks twice without echo, requires 12+ characters, prints
`scrypt$<N>$<r>$<p>$<salt>$<hash>`. The password is never stored.

**On** when both are set; required when `HOST` is public (see "Refusing to start"). Setting both
on the Mac turns login on there too, for testing through Caddy.

**Local HTTPS with Caddy** (Peter's suggestion; Caddy 2.11 is installed). `tools/Caddyfile.local`:
`https://localhost:8443` → `reverse_proxy 127.0.0.1:3031`. A second copy on 3031 with the
server's settings (`JWT_SECRET`, `LOGIN_PASSWORD_HASH`, `SYNC_KEY`, `TRUST_PROXY=1`, scratch
`SELECTIONS_FILE` and data) then behaves as the deployed site does: HTTPS, `Secure` cookies,
HSTS, and a proxy adding `X-Forwarded-For` as Coolify's does. Caddy's local certificate needs its
root trusted once (`caddy trust`, which asks for the Mac's password) — Peter's step, not Claude's.
`SYNC_URL=https://localhost:8443` lets the Mac's Refresh, upload and pull run end to end against it.

**`/login`**: one password field, plus a hidden username field (`peter`, `autocomplete=username`)
so password managers save and fill it. Wrong password: "Wrong password". `POST /api/login`
`{ password }` → sets the cookie, answers 204. `POST /api/logout` clears it; a "Log out" link in
the header of both pages.

**Locked:** every page, file and `/api/` route, except `/login`, its assets and favicon,
`POST /api/login`, `/healthz`, and `/api/sync/*` (its own key). Not logged in: a page request →
302 to `/login`; an API request → 401 JSON, and the pages send a 401 to `/login`.

**Token** (`auth.js`, `node:crypto` only):

- JWT, HS256: header `{"alg":"HS256","typ":"JWT"}`; claims `iat`, `exp` (30 days), `pwf` (first
  16 hex characters of SHA-256 of `LOGIN_PASSWORD_HASH`).
- Cookie `session`: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`, always
  `Secure`. Login is tested locally over HTTPS through Caddy (below), never by loosening the cookie.
- Verify: exactly three base64url parts; header parses and `alg` is exactly `HS256`; signature
  matches by `timingSafeEqual`; `exp` in the future; `pwf` matches the current hash — **a new
  password logs out every device**. Changing `JWT_SECRET` also does.

**Guessing limit:** 5 failed logins (or wrong sync keys) per address per 15 minutes → 429
"Too many attempts — try again in N minutes". The address is the socket's, unless
`TRUST_PROXY=1`, when it is the **last** entry of `X-Forwarded-For` (the one Coolify's proxy
added; earlier entries can be forged). In memory; a restart resets it. No site-wide lockout —
anyone could use it to lock Peter out.

**Security headers on every response** (the helmet equivalent):

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' https: data:; connect-src 'self'; font-src 'self'; object-src 'none';
  base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
  **Both pages' inline `<script type="module">` move to files** (`public/index.js`,
  `public/mine.js`), so scripts need no `'unsafe-inline'` — stricter than MyFinancesWeb, which
  allows it.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` when deployed (login on and
  `Secure` cookies), never on the Mac's plain HTTP.

### Part 5 — Container, Coolify, Hover, first deploy

**`Dockerfile`:** `node:24.22-bookworm-slim`; `PUPPETEER_SKIP_DOWNLOAD=true`;
`npm ci --omit=dev`; app files; `USER node`; `HOST=0.0.0.0`, `PORT=3030`; `CMD ["node", "server.js"]`.
**`.dockerignore`:** `.env*`, `data/`, `node_modules/`, `.git/`, `.superpowers/`, `docs/`, `test/`.

**`/healthz`:** unlocked, answers `ok` (200) — or 503 if ratings or data cannot be read — and
nothing else.

**Volume:** Coolify persistent storage at `/app/data` (`sailings.json`, `.previous`,
`selections.db`, `flights-cache.json` — the cache protects the 250 SerpApi searches a month),
writable by `node` (uid 1000).

**First deploy** (Peter does the dashboard and DNS steps; Claude gives each one):

1. **Hover:** A record `ai-cruises` → `87.99.129.19`. (AAAA optional; the notes give the box's
   range, not its address.)
2. **Coolify:** new app from `peterajones/ai-cruises`, Dockerfile build pack, port 3030, the
   volume, the settings; domain `https://ai-cruises.peter-jones.org` (certificate once DNS
   resolves); deploy webhook on push to `main`, as peterjonesdev2027.
3. **Start:** login page; after login, "No data yet".
4. **Data:** `npm run upload-data` from the Mac.
5. **Ratings:** `npm run push-ratings` from the Mac, once.
6. **Check:** log in on the phone, rate a cruise; `npm run pull-ratings` on the Mac shows it.

**Backups:** check whether `backups-dashboard` covers Coolify volumes; if not, say so (each pull
on the Mac is a copy meanwhile).

**Docs:** CLAUDE.md gains a "Deployment" section (the two roles, settings, sync commands, the
Princess fresh-tab note). Server address and Coolify IDs stay in `~/Projects/deployment-notes.md`,
outside the public repo; the app's URL and Coolify app are added there.

## Testing

Test-first, `node --test`, no network, no real database or server.

- **Princess:** fake browser — a tab per ship, each closed, including when one throws.
- **Refresh:** a fake child process — one at a time; lines kept (last 500); Stop ends it; each
  ending (success, line failed, nothing written, upload failed, pull failed) gives its panel text;
  `available` false without `SYNC_URL`/`SYNC_KEY`.
- **Progress:** `SCRAPE_PROGRESS_MS` changes the interval.
- **Upload:** wrong/missing key → 401; zip bomb stopped at 50 MB; 20 MB compressed limit; not
  JSON; empty; missing fields; fewer than half → refused, `force` accepted; temp + rename;
  `.previous` kept; the server serves the new data.
- **Pull/push:** all columns round-trip; `replaceAll` is all-or-nothing (a failing row leaves the
  old rows); push refused when the server has rows, `force` accepted; the note's time stored.
- **Login:** tampered signature, `alg: none`, `alg: HS512`, wrong secret, expired, before a
  password change, garbage cookie, no cookie → refused; the 6th guess → 429; forged
  `X-Forwarded-For` entries ignored; every locked route → 401 or 302; `/healthz` and `/login`
  open; `hash-password` round-trips and rejects < 12 characters.
- **Refusing to start:** each missing or short setting, and ratings unable to open, with public
  `HOST`; none of it on `127.0.0.1`.
- **Headers:** present on pages, files and API responses; HSTS only when deployed.
- **Headless:** both pages load under the CSP with no console violations, and the main flows
  (search, rate, ✈ panel, `/mine`) still work.
- **Local HTTPS (Caddy):** log in, rate, log out over `https://localhost:8443`; the cookie is
  `Secure`; HSTS present; the guessing limit counts the address Caddy forwards, and a forged
  `X-Forwarded-For` from the browser side does not reset it; a full Refresh → upload → pull
  against it.
- **Container (local, throwaway):** builds; starts; refuses to start without settings; behind
  Caddy, logs in and accepts an upload into a mounted scratch volume.
- **Live:** the first-deploy steps above, then one real Refresh from the Mac.

## Order of work

On a branch; each step its own commit, each working on its own.

1. Princess fresh tab per ship.
2. Security headers and scripts moved to files.
3. Login (`auth.js`, `/login`, `hash-password`, refusing to start).
4. Sync: server routes, `sync.js`, commands, `replaceAll`, the note.
5. Refresh button, panel, `SCRAPE_PROGRESS_MS`.
6. Dockerfile, `.dockerignore`, `/healthz`, `tools/Caddyfile.local`; local Caddy and container checks.
7. Docs.

Then the first deploy with Peter (part 5).

## Out of scope

- Scraping on the server (the spike's numbers are kept above).
- More than one user; sign-up; password reset by email (Peter changes the hash in Coolify).
- Scheduled refreshes.
- Syncing ratings both ways.
- Moving the flights cache between the Mac and the server.
