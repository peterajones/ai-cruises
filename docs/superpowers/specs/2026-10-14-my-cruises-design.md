# My cruises — viewed and rated sailings — design

**Date:** 2026-10-14
**Status:** approved 2026-10-14

## Purpose

Keep track of the cruises Peter has looked at and how he rated them: marks on the cards
wherever they appear, a "My cruises" shortlist, a table to review them, and search that can
use the ratings ("my 5-star cruises", "ones I haven't seen"). This is a launching pad for
planning, not a booking record — ratings are personal notes, on one machine.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| What ratings are for | Shortlist + marks on cards + search that uses them | Peter's choice (3). |
| What counts as "viewed" | Clicking **View ↗** or opening **✈ Flights** | Peter's choice (1): deliberate looks, recorded automatically. Scrolling past is not a view. |
| Rating | 1–5 stars | Peter's choice (1). Fine enough for "rated 4 or more" and "hide 2 or less". |
| Search | Spoken filters only: minimum rating, hide low-rated, viewed / not viewed | Peter's choice (my suggestion). "More like this" is a later follow-up, once there are ratings to learn from. |
| Storage | SQLite via built-in `node:sqlite` — no new dependency | Queries ("4-star Alaska cruises I haven't viewed"), atomic writes. A JSON file was rejected: ratings are not disposable like the flights cache. Browser storage was rejected: one browser only. |
| Node | Upgrade to Node 24.15+ | Peter's choice (1). `node:sqlite` is "Stability: 1.2 – Release candidate" from v24.15.0; on 22.14 and 24.14 it prints an ExperimentalWarning (checked on this machine). |
| Where the data lives | `data/selections.db`, gitignored, plus an export command | Peter's choice (1). Backed up by whatever backs up the Mac; `npm run export-selections` writes a readable JSON copy. |
| Shortlist view | Both: a "My cruises" chip, and a `/mine` table page | Peter's choice (3). |
| "Understood as" box | Keep it; fold the raw filter JSON into a collapsed "Show the filter" toggle | Peter's choice. The plain-English line and the warnings are for everyone; the JSON is the developer's view. |

## Facts this rests on (checked 2026-10-14)

- Node on this machine: 22.14.0 (nvm default) and 24.14.0 installed. No `.nvmrc`; no nvm
  `cd` hook in `~/.zshrc`; `package.json` has `"engines": { "node": ">=22" }`.
- `node:sqlite` works on both installed versions (SQLite 3.51.2 on 24.14), with an
  `ExperimentalWarning`. Node 24 docs history: v22.13.0 unflagged "but still experimental";
  v24.15.0 "SQLite is now a release candidate."
- `.gitignore` covers `data/sailings.json`, `data/runs/`, `data/debug/` and the flights cache —
  not `data/` as a whole, so `data/selections.db` must be added.
- A sailing's `id` is `${source}:${externalId}` (normalize.js), stable across scrapes for the
  same departure.
- The "Understood as" box (public/index.html) shows the plain-English filter, warnings, and
  `<pre>{JSON.stringify(data.filter)}</pre>` — added with the search layer (20d0858), not
  marked as temporary.

## Design

### 0. The "Understood as" toggle

The `<pre>` with the filter JSON moves inside a `<details>` whose `<summary>` reads "Show the
filter", closed by default. The plain-English line and the warnings stay as they are.

### 1. Node 24

- `nvm install 24` (24.15 or later), `.nvmrc` containing `24`, `engines.node` `>=24.15`.
- Before anything else depends on it: the whole suite and a `--dry-run` scrape on Node 24.
- `CLAUDE.md` Environment section: Node 24, why (sqlite), and that `nvm use` (or the nvm `cd`
  hook) picks it up from `.nvmrc`.

### 2. `selections.js` — the only file that touches the database

`data/selections.db`, one table:

```sql
CREATE TABLE IF NOT EXISTS selections (
  sailing_id   TEXT PRIMARY KEY,          -- e.g. 'cunard:M626C'
  rating       INTEGER CHECK (rating BETWEEN 1 AND 5),  -- NULL = not rated
  first_viewed TEXT,                      -- ISO timestamps; NULL = never viewed
  last_viewed  TEXT,
  views        INTEGER NOT NULL DEFAULT 0,
  rated_at     TEXT,
  snapshot     TEXT NOT NULL              -- JSON copy of the sailing, refreshed on each view or rating
);
```

- **Snapshot fields:** `id, line, ship, itinerary, destination, departureDate, nights, price,
  currency, cabin, url, image, departurePort`. Refreshed at each view or rating, so "No longer
  listed" cards and "price then" have something to show.
- **Functions:** `openSelections(path)` → a handle with `all()`, `recordView(sailing, at)`,
  `setRating(sailing, rating|null, at)`, `exportAll()`. Timestamps are passed in (testable).
- **Rules:** a rating outside 1–5 (or non-integer) is refused; `null` clears it. A row with no
  rating and no views is never written. Clearing a rating on a never-viewed sailing deletes the
  row.
- **Failure:** if the database cannot be opened, `openSelections` reports why and the server
  runs without it: search works, `/api/selections` answers 503 with a message, and the page
  shows "Ratings are unavailable" instead of stars.
- A scrape never opens the database.

### 3. Server

- `GET /api/selections` → `{ selections: [{ sailingId, rating, views, firstViewed, lastViewed, ratedAt, snapshot }] }`.
- `POST /api/selections/view` body `{ id }` → records a view of that listed sailing.
- `PUT /api/selections/rating` body `{ id, rating }` (`rating` 1–5 or `null`).
- The server looks the sailing up by `id` in the current dataset for the snapshot. For a
  sailing no longer listed, a rating change updates the row and keeps its old snapshot; a view
  of an unlisted sailing is refused (404) — there is nothing to view.
- Bad input → 400 with a message: a missing `id`, rating 0, 6, 2.5 or a string, malformed JSON.
  An `id` that matches no sailing → 404 "not found" (corrected 2026-10-15: the code's answer,
  and the accurate one — the request was well-formed).
- `npm run export-selections` → writes `data/selections-export-YYYY-MM-DD.json` (readable,
  every row with its snapshot) and prints the path.

### 4. The page (`public/index.html`)

- **Stars** in each card's footer and under the ✈ panel's title: five buttons labelled
  "Rate N stars"; clicking the current rating clears it. Filled to the current rating.
- **"Viewed" tag** on the photo beside "N nights", for viewed cruises; its title gives the last
  view date and the count.
- **Recording views:** clicking View ↗ or opening ✈ sends the view in the background
  (`navigator.sendBeacon` or a fire-and-forget `fetch`); the link and the panel never wait for
  it.
- **"My cruises" chip**, first in the year row, with its count. It shows every row in
  `selections`: rated first, highest first; then unrated by most recent view. Facets, sort,
  batches and the ✈ panel keep working. A sailing not in the current listings (departed, or
  dropped from the scrape) renders from its snapshot, greyed, labelled **"No longer listed"**,
  with no ✈ button. A "Table view ↗" link opens `/mine`.
- **Selections load once** with the page (`GET /api/selections`) and are updated in place on
  each rating or view.

### 5. `/mine` (`public/mine.html`)

A table: Date · Line · Ship · Itinerary (links to the line's page) · Stars (editable) · Price
then · Price now · Views · Last viewed. "Price now" comes from the current listing, with the
change when it moved (e.g. "−$120"); "No longer listed" when absent. Click a header to sort;
the default is the chip's order. A link back to search. Same colours, dark mode, and the page
must work at 800×600 and phone width (16px gutters, the table scrolling sideways inside its
own box, not the page).

### 6. Search

New filter fields, all `null` unless asked for:

| Field | Meaning | Examples |
|---|---|---|
| `minRating` | only sailings rated at least N | "my 4- and 5-star cruises", "ones I loved" (5) |
| `hideRatedAtMost` | drop sailings rated N or lower; unrated stay | "hide anything I rated 2 or less" |
| `viewed` | `true`: only viewed; `false`: only never viewed | "ones I've looked at" / "ones I haven't seen" |

- `brain.js`: the schema gains the three fields; the prompt gains a few examples. The model
  still only produces the filter.
- `search.js`: `searchSailings(sailings, filter, selections = {})` — `selections` maps a
  sailing id to `{ rating, views }`. Stays pure. `hasNoConstraints` and `describeFilter` learn
  the fields ("rated 4★ or more", "hiding 2★ or less", "not yet viewed").
- The server passes the selections map into search. Search covers what is currently listed;
  departed or vanished cruises appear only under My cruises and `/mine`.
- If selections are unavailable (section 2 failure), a search that uses these fields returns
  no results with the message "Ratings are unavailable right now."

## Testing

Test-first, `node --test`:

- `selections.js` against a temporary database: create on first use; view counts and
  timestamps; rate, change, clear; snapshot refreshed; the no-empty-rows rules; refusing bad
  ratings; export; an unopenable path.
- Search: each new field; `hideRatedAtMost` keeps unrated; combinations with cabin and price;
  `describeFilter` and `hasNoConstraints`.
- Endpoints: happy paths and every bad input listed in section 3; 503 when unavailable.
- The page and `/mine`: headless checks at 1440×900, 800×600 and phone width — stars set and
  clear, the Viewed tag, the My cruises chip and its order, a "No longer listed" card, `/mine`
  sorting and price change, the toggle, no page errors. Then Peter's live check.
- The model: a handful of real searches ("my 5-star cruises", "Alaska ones I haven't seen",
  "hide the ones I rated 1") at ~$0.002 each.

## Order of work

On a new branch; each step its own commit.

1. The "Understood as" toggle.
2. Node 24: `.nvmrc`, `engines`, suite and dry-run scrape, `CLAUDE.md`.
3. `selections.js` and the database (`.gitignore`).
4. Endpoints and export.
5. Stars, the Viewed tag, recording views.
6. The My cruises chip.
7. `/mine`.
8. Search filters (`brain.js`, `search.js`).
9. Docs: `CLAUDE.md`, `README.md`.

## Out of scope

- "More like this" (cruises similar to the ones rated highly) — a later follow-up.
- Ratings quietly reordering results.
- Notes on ratings; more than one user; syncing between machines.
