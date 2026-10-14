# My Cruises Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record which cruises Peter viewed and how he rated them (1–5 stars), show it on the cards, in a "My cruises" chip and a `/mine` table, and let search filter on it.

**Architecture:** `selections.js` is the only file that touches `data/selections.db` (built-in `node:sqlite`, Node 24.15+). It exports a store and a request handler the server calls; `search.js` stays pure and receives a `{ id: { rating, views } }` map. The page loads the selections once and updates them in place.

**Tech Stack:** Node 24.15+ (ESM), `node:sqlite`, `node --test`, Puppeteer for headless page checks. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-my-cruises-design.md` — read it first.

## Global Constraints

- Node 24.15 or later. **Every shell command below runs under it:** prefix with `source ~/.nvm/nvm.sh >/dev/null && nvm use >/dev/null &&` (written `N24 &&` below). The nvm default stays 22 — never change it.
- Dependencies stay `puppeteer` and `@anthropic-ai/sdk`. `node:sqlite` is built in.
- `selections.js` is the only file that opens the database. A scrape never opens it.
- Database: `data/selections.db` (gitignored); `SELECTIONS_FILE` env var overrides the path — every check below uses a temporary one, **never Peter's real file**.
- Ratings: integers 1–5, or `null` to clear. A row exists only for a sailing viewed or rated.
- "Viewed" = clicking View ↗ or opening ✈ Flights. Never delays the link or the panel.
- Page code builds DOM with `el()` and `textContent`, never `innerHTML` with data (existing rule in `public/index.html`).
- Headless checks run a server on port 3031 (`PORT=3031`) and stop it afterwards. Keyless copies: `pkill -f "node server.js"` (Peter's `npm run serve` reads `node --env-file-if-exists=.env server.js`, which that pattern does not match). Keyed copies carry the marker argument `--check-3031` and are stopped with `pkill -f "server.js --check-3031"`.
- Commit; never push — Peter pushes.

## Review Focus

1. **Two ratings in quick succession, and the same cruise shown twice** (its card and the ✈ panel). Expected: every copy shows the last rating chosen, and the database holds it. → Task 5.
2. **The database cannot be opened** (a bad path, or Node 22 by mistake). Expected: search and cards work; no stars; one notice says why. → Tasks 3, 4, 6.
3. **A rated cruise that has departed or left the listings.** Expected: under My cruises, greyed and labelled "No longer listed", no ✈ button, and its stars still editable. → Task 6.
4. **"Ones I haven't seen" before anything has been viewed.** Expected: every sailing, not none. → Task 8.
5. **Running under Node 22 by mistake** (forgot `nvm use`). Expected: the app runs; ratings unavailable with a message saying to run `nvm use`. → Task 3.

---

### Task 1: The "Understood as" toggle

**Files:**
- Modify: `public/index.html` (the `box.append(el('pre', …JSON.stringify(data.filter…)))` line, and CSS)

**Interfaces:** none.

- [ ] **Step 1: Make the change**

Replace:

```js
    box.append(el('pre', { text: JSON.stringify(data.filter, null, 2) }));
```

with:

```js
    // The plain-English line above is for everyone; the raw filter is the developer's view.
    box.append(el('details', { class: 'filter-json' },
      el('summary', { text: 'Show the filter' }),
      el('pre', { text: JSON.stringify(data.filter, null, 2) })));
```

Add to the CSS, after the `pre { … }` rule:

```css
  .filter-json summary { cursor: pointer; font-size: 13px; color: var(--muted); margin: 6px 0; }
  .filter-json[open] summary { margin-bottom: 8px; }
```

- [ ] **Step 2: Check it headless (one real search, ~$0.002)**

```bash
N24 && (PORT=3031 node --env-file-if-exists=.env server.js --check-3031 > "$TMPDIR/s.log" 2>&1 &) && sleep 2
cat > "$TMPDIR/check-toggle.mjs" <<'EOF'
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/package.json')('puppeteer');
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3031/', { waitUntil: 'networkidle2' });
await page.type('#q', 'a week in Alaska with a balcony');
await page.click('#go');
await page.waitForFunction(() => document.querySelector('#understood h2')?.textContent === 'Understood as', { timeout: 30000 });
console.log(await page.evaluate(() => {
  const d = document.querySelector('#understood details');
  const closed = d && !d.open && getComputedStyle(d.querySelector('pre')).display === 'none';
  d.querySelector('summary').click();
  return { closedByDefault: closed, opensOnClick: d.open, line: document.querySelector('#understood p').textContent };
}));
await browser.close();
EOF
node "$TMPDIR/check-toggle.mjs"; pkill -f "server.js --check-3031"
```

Expected: `{ closedByDefault: true, opensOnClick: true, line: '7 nights, balcony and Alaska — N matches, …' }`. (`--check-3031` is an ignored argument that marks this copy, so `pkill` stops it and never Peter's `npm run serve`.)

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "Fold the raw search filter into a 'Show the filter' toggle"
```

---

### Task 2: Node 24

**Files:**
- Create: `.nvmrc`
- Modify: `package.json` (`engines`), `CLAUDE.md` (Environment)

**Interfaces:** Produces: every later command runs under Node ≥ 24.15 via `N24 &&`.

- [ ] **Step 1: Install and pin**

```bash
source ~/.nvm/nvm.sh && nvm install 24 && node -v
printf '24\n' > .nvmrc
N24 && node -v && node -e 'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync(":memory:"); console.log("sqlite ok")'
```

Expected: `v24.x.y` with x ≥ 15, then `sqlite ok` and **no** `ExperimentalWarning`. If x < 15, stop and report — the spec's reason for upgrading would not hold.

In `package.json` change `"node": ">=22"` to `"node": ">=24.15"`.

- [ ] **Step 2: The suite and a dry-run scrape on Node 24**

```bash
N24 && npm test 2>&1 | grep -E '^# (tests|pass|fail)'
N24 && node scrape.js --limit 5 --dry-run > "$TMPDIR/n24-dry.txt" 2>&1; echo "exit: $?"; grep -E '^[a-z-]+: [0-9]|DRY RUN' "$TMPDIR/n24-dry.txt"
```

Expected: 241 pass, 0 fail; exit 0 and every line reports sailings. (A small, polite run: ~5 sailings per line.)

- [ ] **Step 3: Record it in `CLAUDE.md`**

In the Environment section, replace `- Node 22. Dependencies:` with:

```markdown
- Node 24.15+ (`.nvmrc`; `nvm use` in this folder — the nvm default on this machine is still 22).
  24.15 is where built-in `node:sqlite` became a release candidate; My cruises stores ratings
  with it. Dependencies:
```

- [ ] **Step 4: Commit**

```bash
git add .nvmrc package.json CLAUDE.md
git commit -m "Move to Node 24.15+ for built-in SQLite"
```

---

### Task 3: `selections.js` — the store

**Files:**
- Create: `selections.js`
- Modify: `.gitignore`, `package.json` (script `export-selections`)
- Test: `test/selections.test.js`

**Interfaces:**
- Produces:
  - `nodeSupportsSqlite(version?: string): boolean`
  - `snapshotOf(sailing): object` — the 13 snapshot fields
  - `openSelections(path, { version? }?): Promise<Store | { ok: false, reason: string }>`
  - `Store`: `{ ok: true, all(): Row[], get(id): Row|null, recordView(sailing, at): Row, setRating(id, rating|null, at, sailing|null): Row|null, close() }`
  - `Row`: `{ sailingId, rating, views, firstViewed, lastViewed, ratedAt, snapshot }`
  - `selectionMap(store): { [id]: { rating, views } }` — `{}` when `!store.ok`
  - `DEFAULT_FILE` — `data/selections.db`

- [ ] **Step 1: Write the failing tests**

Create `test/selections.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSelections, nodeSupportsSqlite, snapshotOf, selectionMap } from '../selections.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'sel-')), 'selections.db');
const sailing = (over = {}) => ({
  id: 'cunard:M626C', line: 'Cunard', ship: 'Queen Mary 2', itinerary: 'Southampton To Hamburg',
  destination: 'europe', departureDate: '2026-10-18', nights: 2, price: 504.74, currency: 'CAD',
  cabin: 'interior', url: 'https://www.cunard.com/x', image: null, departurePort: 'Southampton',
  ports: ['ignored'], cabinPrices: { interior: 504.74 }, ...over,
});

test('Node 24.15 or later is needed', () => {
  assert.equal(nodeSupportsSqlite('22.14.0'), false);
  assert.equal(nodeSupportsSqlite('24.14.0'), false);
  assert.equal(nodeSupportsSqlite('24.15.0'), true);
  assert.equal(nodeSupportsSqlite('25.0.0'), true);
});

test('on an older Node the store is unavailable, with a reason that says what to do', async () => {
  const store = await openSelections(tmp(), { version: '22.14.0' });
  assert.equal(store.ok, false);
  assert.match(store.reason, /Node 24\.15/);
  assert.match(store.reason, /nvm use/);
});

test('a path that cannot be a database is unavailable, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sel-'));
  mkdirSync(join(dir, 'selections.db'));
  const store = await openSelections(join(dir, 'selections.db'));
  assert.equal(store.ok, false);
  assert.match(store.reason, /Could not open/);
});

test('a new database starts empty', async () => {
  const store = await openSelections(tmp());
  assert.equal(store.ok, true);
  assert.deepEqual(store.all(), []);
});

test('a view creates a row, then counts', async () => {
  const store = await openSelections(tmp());
  const first = store.recordView(sailing(), '2026-10-14T10:00:00Z');
  assert.equal(first.views, 1);
  assert.equal(first.rating, null);
  assert.equal(first.firstViewed, '2026-10-14T10:00:00Z');
  const second = store.recordView(sailing({ price: 480 }), '2026-10-15T09:00:00Z');
  assert.equal(second.views, 2);
  assert.equal(second.firstViewed, '2026-10-14T10:00:00Z');
  assert.equal(second.lastViewed, '2026-10-15T09:00:00Z');
  assert.equal(second.snapshot.price, 480, 'the snapshot is refreshed');
});

test('the snapshot keeps the card fields and nothing else', () => {
  assert.deepEqual(Object.keys(snapshotOf(sailing())).sort(), [
    'cabin', 'currency', 'departureDate', 'departurePort', 'destination', 'id', 'image',
    'itinerary', 'line', 'nights', 'price', 'ship', 'url',
  ]);
});

test('rate, change, and clear a rating', async () => {
  const store = await openSelections(tmp());
  assert.equal(store.setRating('cunard:M626C', 4, 'T1', sailing()).rating, 4);
  const changed = store.setRating('cunard:M626C', 2, 'T2', sailing());
  assert.equal(changed.rating, 2);
  assert.equal(changed.ratedAt, 'T2');
  // Never viewed, rating cleared: nothing left to keep.
  assert.equal(store.setRating('cunard:M626C', null, 'T3', sailing()), null);
  assert.deepEqual(store.all(), []);
});

test('clearing the rating of a viewed sailing keeps the view', async () => {
  const store = await openSelections(tmp());
  store.recordView(sailing(), 'T1');
  store.setRating('cunard:M626C', 5, 'T2', sailing());
  const row = store.setRating('cunard:M626C', null, 'T3', sailing());
  assert.equal(row.rating, null);
  assert.equal(row.views, 1);
});

test('a sailing no longer listed can be re-rated and keeps its old snapshot', async () => {
  const store = await openSelections(tmp());
  store.setRating('cunard:M626C', 3, 'T1', sailing({ price: 600 }));
  const row = store.setRating('cunard:M626C', 5, 'T2', null);
  assert.equal(row.rating, 5);
  assert.equal(row.snapshot.price, 600);
});

test('a rating that is not a whole number from 1 to 5 is refused', async () => {
  const store = await openSelections(tmp());
  for (const bad of [0, 6, 2.5, '4', undefined]) {
    assert.throws(() => store.setRating('cunard:M626C', bad, 'T', sailing()), RangeError, String(bad));
  }
  assert.deepEqual(store.all(), []);
});

test('rating an unknown sailing with nothing to snapshot is refused', async () => {
  const store = await openSelections(tmp());
  assert.throws(() => store.setRating('cunard:NOPE', 4, 'T', null), /No sailing/);
});

test('the map search uses holds rating and views by id', async () => {
  const store = await openSelections(tmp());
  store.recordView(sailing(), 'T1');
  store.setRating('viking:X', 2, 'T2', sailing({ id: 'viking:X' }));
  assert.deepEqual(selectionMap(store), {
    'cunard:M626C': { rating: null, views: 1 },
    'viking:X': { rating: 2, views: 0 },
  });
  assert.deepEqual(selectionMap({ ok: false, reason: 'x' }), {});
});

test('the data survives closing and reopening', async () => {
  const path = tmp();
  const a = await openSelections(path);
  a.setRating('cunard:M626C', 4, 'T1', sailing());
  a.close();
  const b = await openSelections(path);
  assert.equal(b.get('cunard:M626C').rating, 4);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `N24 && node --test test/selections.test.js 2>&1 | grep -E "Cannot find|^# (pass|fail)"`
Expected: FAIL — `Cannot find module '…/selections.js'`.

- [ ] **Step 3: Write `selections.js`**

```js
/**
 * The cruises Peter has viewed and rated. The only file that touches the database —
 * as brain.js is the only file that calls a model.
 *
 * One row per sailing viewed (View ↗ or ✈ Flights) or rated (1–5 stars), with a copy of
 * the sailing as it was, so a cruise that departs or leaves the listings still shows.
 * Built-in node:sqlite: a release candidate from Node 24.15. See
 * docs/superpowers/specs/2026-10-14-my-cruises-design.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_FILE = new URL('./data/selections.db', import.meta.url).pathname;

const SNAPSHOT_FIELDS = [
  'id', 'line', 'ship', 'itinerary', 'destination', 'departureDate', 'nights', 'price',
  'currency', 'cabin', 'url', 'image', 'departurePort',
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS selections (
    sailing_id   TEXT PRIMARY KEY,
    rating       INTEGER CHECK (rating BETWEEN 1 AND 5),
    first_viewed TEXT,
    last_viewed  TEXT,
    views        INTEGER NOT NULL DEFAULT 0,
    rated_at     TEXT,
    snapshot     TEXT NOT NULL
  )`;

/** node:sqlite is a release candidate from 24.15; before that it warns it may change. */
export function nodeSupportsSqlite(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 15);
}

/** The fields a card needs, as they were — for cruises no longer listed, and "price then". */
export function snapshotOf(sailing) {
  return Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, sailing[f] ?? null]));
}

const isRating = (r) => Number.isInteger(r) && r >= 1 && r <= 5;

const toRow = (r) => (r ? {
  sailingId: r.sailing_id,
  rating: r.rating,
  views: r.views,
  firstViewed: r.first_viewed,
  lastViewed: r.last_viewed,
  ratedAt: r.rated_at,
  snapshot: JSON.parse(r.snapshot),
} : null);

function storeFor(db) {
  const q = {
    all: db.prepare('SELECT * FROM selections ORDER BY sailing_id'),
    get: db.prepare('SELECT * FROM selections WHERE sailing_id = ?'),
    view: db.prepare(`
      INSERT INTO selections (sailing_id, first_viewed, last_viewed, views, snapshot)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(sailing_id) DO UPDATE SET
        views = views + 1, last_viewed = excluded.last_viewed,
        first_viewed = COALESCE(first_viewed, excluded.first_viewed), snapshot = excluded.snapshot`),
    rate: db.prepare(`
      INSERT INTO selections (sailing_id, rating, rated_at, snapshot) VALUES (?, ?, ?, ?)
      ON CONFLICT(sailing_id) DO UPDATE SET
        rating = excluded.rating, rated_at = excluded.rated_at, snapshot = excluded.snapshot`),
    remove: db.prepare('DELETE FROM selections WHERE sailing_id = ?'),
  };

  const store = {
    ok: true,
    all: () => q.all.all().map(toRow),
    get: (id) => toRow(q.get.get(id)),

    /** A view of a listed sailing: counts it and refreshes its snapshot. */
    recordView(sailing, at) {
      q.view.run(sailing.id, at, at, JSON.stringify(snapshotOf(sailing)));
      return store.get(sailing.id);
    },

    /**
     * Sets (1–5) or clears (null) a rating. `sailing` is the listed sailing, or null when it
     * is no longer listed — then the old snapshot stays. A row with no rating and no views
     * is deleted rather than kept empty.
     */
    setRating(id, rating, at, sailing) {
      if (rating !== null && !isRating(rating)) {
        throw new RangeError(`A rating is a whole number from 1 to 5, or null — not ${JSON.stringify(rating)}`);
      }
      const existing = store.get(id);
      if (rating === null) {
        if (!existing) return null;
        if (existing.views === 0) {
          q.remove.run(id);
          return null;
        }
      } else if (!existing && !sailing) {
        throw new Error(`No sailing ${id} to rate`);
      }
      const snapshot = sailing ? snapshotOf(sailing) : existing.snapshot;
      q.rate.run(id, rating, rating === null ? null : at, JSON.stringify(snapshot));
      return store.get(id);
    },

    close: () => db.close(),
  };
  return store;
}

/**
 * Opens (creating if needed) the database. Never throws: a store that cannot open says why,
 * and the app runs without ratings.
 */
export async function openSelections(path = DEFAULT_FILE, { version } = {}) {
  const running = version ?? process.versions.node;
  if (!nodeSupportsSqlite(running)) {
    return {
      ok: false,
      reason: `Ratings need Node 24.15 or later (this is ${running}) — run \`nvm use\` in the project folder.`,
    };
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    return storeFor(db);
  } catch (err) {
    return { ok: false, reason: `Could not open ${path}: ${err.message}` };
  }
}

/** What search needs: rating and views by sailing id. Empty when ratings are unavailable. */
export function selectionMap(store) {
  if (!store?.ok) return {};
  return Object.fromEntries(store.all().map((r) => [r.sailingId, { rating: r.rating, views: r.views }]));
}

// npm run export-selections — a readable copy, for backups.
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--export')) {
  const store = await openSelections(process.env.SELECTIONS_FILE || DEFAULT_FILE);
  if (!store.ok) {
    console.error(store.reason);
    process.exit(1);
  }
  const rows = store.all();
  const day = new Date().toLocaleDateString('en-CA');
  const out = new URL(`./data/selections-export-${day}.json`, import.meta.url).pathname;
  writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), selections: rows }, null, 2));
  console.log(`Wrote ${rows.length} selections to ${out}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `N24 && node --test test/selections.test.js 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"`
Expected: PASS, 13 tests.

- [ ] **Step 5: Ignore the database, add the export script, check it**

Append to `.gitignore` under the scraper-output block:

```gitignore
# My cruises — Peter's ratings; back up with `npm run export-selections`
data/selections.db*
data/selections-export-*.json
```

(`*` covers SQLite's `-journal`/`-wal` side files.) In `package.json` scripts add `"export-selections": "node selections.js --export"`.

```bash
N24 && SELECTIONS_FILE="$TMPDIR/sel-export.db" npm run export-selections 2>&1 | tail -1
git status --short --ignored data/ | grep selections
```

Expected: `Wrote 0 selections to …/data/selections-export-YYYY-MM-DD.json`, and `git status` lists it as ignored (`!!`). Delete that export file afterwards.

- [ ] **Step 6: Whole suite, commit**

Run: `N24 && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` — Expected: 254 pass, 0 fail.

```bash
git add selections.js test/selections.test.js .gitignore package.json
git commit -m "Store viewed and rated sailings in SQLite"
```

---

### Task 4: The endpoints

**Files:**
- Modify: `selections.js` (add `handleSelections`), `server.js`
- Test: `test/selections.test.js`

**Interfaces:**
- Consumes: `Store`, `openSelections`, `DEFAULT_FILE` (Task 3).
- Produces: `handleSelections({ method, path, body }, { store, sailings, now? }): { status, body } | null` — `null` when `path` is not under `/api/selections`. Server routes: `GET /api/selections` → `{ selections: Row[] }`; `POST /api/selections/view` `{ id }` → `{ selection }`; `PUT /api/selections/rating` `{ id, rating }` → `{ selection }` (`null` when cleared away). The server reads `SELECTIONS_FILE` (default `DEFAULT_FILE`).

- [ ] **Step 1: Write the failing tests**

Add `handleSelections` to the import, then append:

```js
const listed = [sailing(), sailing({ id: 'viking:X', line: 'Viking' })];
const call = (store, method, path, body) =>
  handleSelections({ method, path, body: body === undefined ? '' : JSON.stringify(body) },
    { store, sailings: listed, now: () => 'NOW' });

test('the handler ignores other paths', async () => {
  assert.equal(call(await openSelections(tmp()), 'GET', '/api/dataset'), null);
});

test('GET lists, POST view records, PUT rating sets and clears', async () => {
  const store = await openSelections(tmp());
  assert.deepEqual(call(store, 'GET', '/api/selections'), { status: 200, body: { selections: [] } });
  const viewed = call(store, 'POST', '/api/selections/view', { id: 'cunard:M626C' });
  assert.equal(viewed.status, 200);
  assert.equal(viewed.body.selection.views, 1);
  assert.equal(viewed.body.selection.lastViewed, 'NOW');
  const rated = call(store, 'PUT', '/api/selections/rating', { id: 'viking:X', rating: 5 });
  assert.equal(rated.body.selection.rating, 5);
  const cleared = call(store, 'PUT', '/api/selections/rating', { id: 'viking:X', rating: null });
  assert.deepEqual(cleared, { status: 200, body: { selection: null } });
  assert.equal(call(store, 'GET', '/api/selections').body.selections.length, 1);
});

test('bad input is a 400 with a message', async () => {
  const store = await openSelections(tmp());
  const cases = [
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: 0 }],
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: 6 }],
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: 2.5 }],
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C', rating: '4' }],
    ['PUT', '/api/selections/rating', { id: 'cunard:M626C' }],
    ['PUT', '/api/selections/rating', { rating: 4 }],
    ['POST', '/api/selections/view', {}],
    ['POST', '/api/selections/view', [1, 2]],
  ];
  for (const [m, p, b] of cases) {
    const out = call(store, m, p, b);
    assert.equal(out.status, 400, JSON.stringify(b));
    assert.equal(typeof out.body.error, 'string');
  }
  const notJson = handleSelections({ method: 'POST', path: '/api/selections/view', body: '{nope' },
    { store, sailings: listed });
  assert.equal(notJson.status, 400);
  assert.deepEqual(store.all(), []);
});

test('an unknown sailing is a 404; a view of an unlisted one too', async () => {
  const store = await openSelections(tmp());
  assert.equal(call(store, 'POST', '/api/selections/view', { id: 'cunard:GONE' }).status, 404);
  assert.equal(call(store, 'PUT', '/api/selections/rating', { id: 'cunard:GONE', rating: 3 }).status, 404);
});

test('an unlisted sailing that has a row can still be re-rated', async () => {
  const store = await openSelections(tmp());
  store.setRating('cunard:GONE', 2, 'T1', sailing({ id: 'cunard:GONE' }));
  const out = call(store, 'PUT', '/api/selections/rating', { id: 'cunard:GONE', rating: 4 });
  assert.equal(out.status, 200);
  assert.equal(out.body.selection.rating, 4);
});

test('an unknown method or sub-path is a 404', async () => {
  const store = await openSelections(tmp());
  assert.equal(call(store, 'DELETE', '/api/selections').status, 404);
  assert.equal(call(store, 'GET', '/api/selections/rating').status, 404);
});

test('when the store is unavailable every route is a 503 saying why', () => {
  const store = { ok: false, reason: 'Ratings need Node 24.15 or later' };
  for (const [m, p] of [['GET', '/api/selections'], ['POST', '/api/selections/view'], ['PUT', '/api/selections/rating']]) {
    assert.deepEqual(call(store, m, p, { id: 'cunard:M626C', rating: 3 }),
      { status: 503, body: { error: 'Ratings need Node 24.15 or later' } });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `N24 && node --test test/selections.test.js 2>&1 | grep -E "does not provide|^# (pass|fail)"`
Expected: FAIL — `does not provide an export named 'handleSelections'`.

- [ ] **Step 3: Implement the handler**

Append to `selections.js`, before the export block:

```js
const bad = (error) => ({ status: 400, body: { error } });

/**
 * The /api/selections routes, as a plain function the server calls (and tests call
 * directly). `sailings` are the currently listed ones: a view needs one; a rating needs one
 * or an existing row.
 *
 * @returns {{status: number, body: object}|null} null when the path is not ours
 */
export function handleSelections({ method, path, body }, { store, sailings, now = () => new Date().toISOString() }) {
  if (!path.startsWith('/api/selections')) return null;
  if (!store?.ok) return { status: 503, body: { error: store?.reason ?? 'Ratings are unavailable.' } };

  if (method === 'GET' && path === '/api/selections') return { status: 200, body: { selections: store.all() } };
  const isView = method === 'POST' && path === '/api/selections/view';
  const isRate = method === 'PUT' && path === '/api/selections/rating';
  if (!isView && !isRate) return { status: 404, body: { error: 'Not found' } };

  let input;
  try {
    input = JSON.parse(body || '{}');
  } catch {
    return bad('The request body is not JSON.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Send a JSON object.');
  if (typeof input.id !== 'string' || !input.id) return bad('Which sailing? Send { "id": "…" }.');

  const sailing = sailings.find((s) => s.id === input.id) ?? null;

  if (isView) {
    if (!sailing) return { status: 404, body: { error: `No listed sailing ${input.id} to view.` } };
    return { status: 200, body: { selection: store.recordView(sailing, now()) } };
  }

  if (!('rating' in input)) return bad('Send { "id", "rating" }: a rating from 1 to 5, or null to clear it.');
  const { rating } = input;
  if (rating !== null && !isRating(rating)) return bad('A rating is a whole number from 1 to 5, or null to clear it.');
  if (!sailing && !store.get(input.id)) return { status: 404, body: { error: `No sailing ${input.id}.` } };
  return { status: 200, body: { selection: store.setRating(input.id, rating, now(), sailing) } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `N24 && node --test test/selections.test.js 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"`
Expected: PASS, 20 tests.

- [ ] **Step 5: Wire the server**

In `server.js`:

```js
import { openSelections, handleSelections, DEFAULT_FILE as SELECTIONS_DEFAULT } from './selections.js';
```

after the `FLIGHTS_CACHE` constant:

```js
// SELECTIONS_FILE points a second copy (port 3031) at a scratch database, so checks never
// touch Peter's ratings.
const SELECTIONS_FILE = process.env.SELECTIONS_FILE || SELECTIONS_DEFAULT;
```

after `dataset = await loadDataset();` near the bottom:

```js
const selections = await openSelections(SELECTIONS_FILE);
```

and in the `server.listen` callback, after the sailings line:

```js
  console.log(selections.ok ? `Ratings: ${SELECTIONS_FILE}` : `Ratings unavailable: ${selections.reason}`);
```

Inside the request handler, immediately before the `/api/flights?` route:

```js
    if (req.url.startsWith('/api/selections')) {
      dataset = await loadDataset();
      let body = '';
      if (req.method !== 'GET') for await (const chunk of req) body += chunk;
      const out = handleSelections(
        { method: req.method, path: req.url.split('?')[0], body },
        { store: selections, sailings: dataset ? current(dataset).sailings : [] },
      );
      return json(res, out.status, out.body);
    }
```

(`selections` is declared with `const` at module scope after the handler is defined; it is assigned before `server.listen`, so every request sees it.)

- [ ] **Step 6: Check it over HTTP**

```bash
rm -f "$TMPDIR/sel-check.db"
N24 && (PORT=3031 SELECTIONS_FILE="$TMPDIR/sel-check.db" node server.js > "$TMPDIR/s.log" 2>&1 &) && sleep 2
ID=$(curl -s localhost:3031/api/dataset | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).sailings[0].id))')
curl -s -X POST localhost:3031/api/selections/view -d "{\"id\":\"$ID\"}"; echo
curl -s -X PUT localhost:3031/api/selections/rating -d "{\"id\":\"$ID\",\"rating\":4}"; echo
curl -s -X PUT localhost:3031/api/selections/rating -d "{\"id\":\"$ID\",\"rating\":9}"; echo
curl -s localhost:3031/api/selections | head -c 200; echo
grep Ratings "$TMPDIR/s.log"; pkill -f "node server.js"
```

Expected: a selection with `views:1`; then `rating:4`; then a 400 error message; the list holds one row; the log says `Ratings: …/sel-check.db`.

- [ ] **Step 7: Whole suite, commit**

Run: `N24 && npm test 2>&1 | grep -E '^# (tests|pass|fail)'` — Expected: 261 pass, 0 fail.

```bash
git add selections.js server.js test/selections.test.js
git commit -m "Serve viewed and rated sailings over /api/selections"
```

---

### Task 5: Stars, the Viewed tag, and recording views

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: the three endpoints (Task 4).
- Produces (page): `state.selections` (`{ [id]: Row }`), `state.selectionsOk`, `state.selectionsWhy`; `starsFor(s)`, `paintStars(id)`, `rate(s, rating|null)`, `recordView(s)`, `viewedTag(s)`, `markViewed(s)`; `let updateMineCount = () => {}` (Task 6 replaces it). Star groups carry `data-stars="<id>"`; thumbs carry `data-thumb="<id>"`.

- [ ] **Step 1: State and loading**

Change the `state` line to add the three fields:

```js
const state = { all: [], subset: null, message: null, values: {}, facets: {}, searchCabin: null,
  selections: {}, selectionsOk: true, selectionsWhy: null };
```

In `boot()`, after `state.values = data.values;`:

```js
  // Ratings load once; each change updates them in place. Unavailable is not an error page:
  // search works, and one notice says why (see buildYearChips).
  try {
    const sres = await fetch('/api/selections');
    const sdata = await sres.json();
    if (!sres.ok) throw new Error(sdata.error);
    state.selections = Object.fromEntries(sdata.selections.map((r) => [r.sailingId, r]));
  } catch (err) {
    state.selectionsOk = false;
    state.selectionsWhy = `Ratings are unavailable: ${err.message}`;
  }
```

- [ ] **Step 2: Stars, views, and the Viewed tag**

Add after `flightsButton`:

```js
/** Called when the My cruises count changes; buildYearChips replaces it. */
let updateMineCount = () => {};
/** Bumped per rating click, per sailing, so a slow earlier answer never repaints over a later one. */
const rateTickets = {};

/** Five buttons; clicking the current rating clears it. One group per copy of the cruise on screen. */
function starsFor(s) {
  if (!state.selectionsOk) return null;
  const group = el('div', { class: 'stars', role: 'group', 'aria-label': 'Your rating', 'data-stars': s.id });
  for (let n = 1; n <= 5; n += 1) {
    const b = el('button', { type: 'button', 'aria-label': `Rate ${n} star${n === 1 ? '' : 's'}` });
    b.onclick = (e) => {
      e.stopPropagation();
      rate(s, (state.selections[s.id]?.rating ?? 0) === n ? null : n);
    };
    group.append(b);
  }
  paintGroup(group, state.selections[s.id]?.rating ?? 0);
  return group;
}

function paintGroup(group, rating) {
  [...group.children].forEach((b, i) => {
    b.className = i < rating ? 'star on' : 'star';
    b.textContent = i < rating ? '★' : '☆';
    b.setAttribute('aria-pressed', String(i + 1 === rating));
  });
}

function paintStars(id) {
  const rating = state.selections[id]?.rating ?? 0;
  for (const g of document.querySelectorAll(`[data-stars="${CSS.escape(id)}"]`)) paintGroup(g, rating);
}

async function rate(s, rating) {
  const ticket = (rateTickets[s.id] = (rateTickets[s.id] ?? 0) + 1);
  const before = state.selections[s.id];
  state.selections[s.id] = { ...(before ?? { sailingId: s.id, views: 0, snapshot: s }), rating };
  paintStars(s.id);
  try {
    const res = await fetch('/api/selections/rating', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: s.id, rating }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (ticket !== rateTickets[s.id]) return; // a later click owns the display now
    if (data.selection) state.selections[s.id] = data.selection;
    else delete state.selections[s.id];
  } catch (err) {
    if (ticket !== rateTickets[s.id]) return;
    if (before) state.selections[s.id] = before;
    else delete state.selections[s.id];
    console.error('Rating not saved:', err.message);
  }
  paintStars(s.id);
  updateMineCount();
}

/** In the background: the link and the panel never wait for it. Unlisted cruises can't be viewed. */
function recordView(s) {
  if (!state.selectionsOk || s.unlisted) return;
  fetch('/api/selections/view', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: s.id }), keepalive: true,
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data?.selection) return;
      state.selections[s.id] = data.selection;
      markViewed(s);
      updateMineCount();
    })
    .catch(() => {});
}

function viewedTag(s) {
  const r = state.selections[s.id];
  if (!r?.views) return null;
  const last = r.lastViewed ? new Date(r.lastViewed).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  return el('span', { class: 'viewed', title: `Viewed ${r.views}× · last ${last}`, text: 'Viewed' });
}

function markViewed(s) {
  for (const t of document.querySelectorAll(`[data-thumb="${CSS.escape(s.id)}"]`)) {
    t.querySelector('.viewed')?.remove();
    const tag = viewedTag(s);
    if (tag) t.append(tag);
  }
}
```

- [ ] **Step 3: Put them on the card and in the panel**

In `cardFor`:
- `const thumb = el('div', { class: 'thumb' });` → `const thumb = el('div', { class: 'thumb', 'data-thumb': s.id });`
- after the `nights` span is appended: `const tag = viewedTag(s); if (tag) thumb.append(tag);`
- replace the View link and the foot so the link records a view and the stars sit in the foot:

```js
  const link = safeUrl(s.url);
  const view = link ? el('a', { class: 'book', href: link, target: '_blank', rel: 'noopener', text: ' View ↗' }) : null;
  if (view) view.onclick = () => recordView(s);
  const foot = el('div', { class: 'foot' },
    el('div', {}, price, priceLabel),
    el('div', {}, flightsButton(s), view));
```

  and add `starsFor(s)` as the last child of the card body, after `foot`:

```js
        cabinRow,
        foot,
        starsFor(s)));
```

In `openPanel(s, opener)`, as its first line: `recordView(s);` — and in the hero, after the `hero-meta` div: `starsFor(s),` (inside `el('div', { class: 'hero-text' }, …)`).

CSS, after `.tour { … }`:

```css
  .viewed {
    position: absolute; right: 12px; top: 12px; background: rgba(6,20,28,.82); color: #fff;
    font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 999px;
  }
  .stars { display: flex; gap: 2px; }
  .stars .star { background: none; border: 0; padding: 0 1px; font-size: 19px; line-height: 1;
    color: var(--muted); cursor: pointer; }
  .stars .star.on { color: #e8a317; }
  .stars .star:focus-visible { outline: 2px solid var(--accent); border-radius: 4px; }
  .panel .hero-text .stars { margin-top: 6px; }
  .panel .hero-text .star { color: rgba(255,255,255,.75); }
  .panel .hero-text .star.on { color: #ffc940; }
```

- [ ] **Step 4: Check it headless (scratch database; no model calls)**

```bash
rm -f "$TMPDIR/sel-check.db"
N24 && (PORT=3031 SELECTIONS_FILE="$TMPDIR/sel-check.db" node server.js > "$TMPDIR/s.log" 2>&1 &) && sleep 2
cat > "$TMPDIR/check-stars.mjs" <<'EOF'
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/package.json')('puppeteer');
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:3031/', { waitUntil: 'networkidle2' });
const r = await page.evaluate(async () => {
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const card = document.querySelector('article.card');
  const id = card.querySelector('[data-stars]').dataset.stars;
  const shown = () => [...document.querySelectorAll(`[data-stars="${CSS.escape(id)}"]`)].map((g) => g.querySelectorAll('.on').length);
  card.querySelector('[data-stars] button:nth-child(3)').click();
  card.querySelector('[data-stars] button:nth-child(5)').click();   // a quick second rating
  await wait(700);
  const afterTwo = shown();
  card.querySelector('.flights-btn').click();                       // opens the panel: a view
  await wait(700);
  const cardAndPanel = shown();
  const viewed = !!card.querySelector('.viewed');
  document.querySelector('#panel [data-stars] button:nth-child(5)').click(); // same star clears
  await wait(700);
  const cleared = shown();
  const sel = await (await fetch('/api/selections')).json();
  return { afterTwo, cardAndPanel, viewed, cleared, row: sel.selections.find((x) => x.sailingId === id) };
});
console.log(JSON.stringify(r), errors.length ? 'ERRORS ' + errors.join('; ') : 'no page errors');
for (const [w, h] of [[800, 600], [390, 800]]) {
  await page.setViewport({ width: w, height: h });
  const card = await page.$('article.card');
  await card.screenshot({ path: `${process.env.TMPDIR}/card-${w}.png` });
}
await browser.close();
EOF
N24 && node "$TMPDIR/check-stars.mjs"; pkill -f "node server.js"
```

Expected: `afterTwo [5]`, `cardAndPanel [5,5]`, `viewed true`, `cleared [0,0]`, `row` with `rating: null` and `views: 1`; no page errors. Look at `card-800.png` and `card-390.png`: stars on their own row under the price, not overlapping; the Viewed tag top-right of the photo.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Rate cruises with stars, and mark the ones you've viewed"
```

---

### Task 6: The My cruises chip

**Files:**
- Modify: `public/index.html` (`buildYearChips`, `applyFacets`, `render`, `cardFor`, CSS)

**Interfaces:**
- Consumes: `state.selections`, `state.selectionsOk`, `state.selectionsWhy`, `updateMineCount` (Task 5).
- Produces: `state.facets.year === 'mine'` means My cruises; `mineList(): Sailing[]` (listed sailings, or snapshots with `unlisted: true`).

- [ ] **Step 1: The chip, the list, and its order**

In `buildYearChips`, replace `chip(null, 'All', state.all.length);` with:

```js
  if (state.selectionsOk) {
    const mine = chip('mine', 'My cruises', Object.keys(state.selections).length);
    updateMineCount = () => {
      mine.querySelector('.yearcount').textContent = String(Object.keys(state.selections).length);
    };
  }
  chip(null, 'All', state.all.length);
```

and after the `for (const y of years)` loop:

```js
  host.append(state.selectionsOk
    ? el('a', { class: 'table-link', href: '/mine', text: 'Table view ↗' })
    : el('span', { class: 'ratings-off', text: state.selectionsWhy }));
```

Add after `buildYearChips`:

```js
/**
 * Everything viewed or rated: rated first, highest first; then by most recent view. A
 * sailing no longer listed (departed, or gone from the scrape) comes from its snapshot.
 */
function mineList() {
  const byId = new Map(state.all.map((s) => [s.id, s]));
  return Object.values(state.selections)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)
      || String(b.lastViewed ?? '').localeCompare(String(a.lastViewed ?? '')))
    .map((r) => byId.get(r.sailingId) ?? { ...r.snapshot, id: r.sailingId, unlisted: true });
}
```

In `render`, replace `const base = state.subset ?? state.all;` with:

```js
  const mine = state.facets.year === 'mine';
  const base = mine ? mineList() : (state.subset ?? state.all);
```

and the empty-state line with:

```js
    const why = mine
      ? "Nothing here yet — open a cruise's View ↗ or ✈ Flights, or give it stars."
      : (state.message ?? "Nothing matches those filters — you've had enough sun anyway.");
```

In `applyFacets`:
- year: `(!f.year || s.departureDate.startsWith(f.year))` → `(!f.year || f.year === 'mine' || s.departureDate.startsWith(f.year))`
- sort: keep My cruises' own order until a sort is chosen:

```js
  const by = f.sort ?? (f.year === 'mine' ? null : 'price');
  if (!by) return out;
```

  (placed before the existing `out = [...out].sort(…)`, which keeps using `by`).

- [ ] **Step 2: "No longer listed" cards**

In `cardFor`:
- the article: `el('article', { class: 'card' }, …` → `el('article', { class: s.unlisted ? 'card unlisted' : 'card' }, …`
- after the Viewed tag: `if (s.unlisted) thumb.append(el('span', { class: 'gone', text: 'No longer listed' }));`
- the foot's buttons: `flightsButton(s)` → `s.unlisted ? null : flightsButton(s)`

CSS:

```css
  .card.unlisted { filter: grayscale(.7); opacity: .72; }
  .card.unlisted:hover, .card.unlisted:focus-within { opacity: 1; }
  .gone {
    position: absolute; left: 12px; top: 44px; background: #6b7580; color: #fff;
    font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 999px;
  }
  .table-link { align-self: center; margin-left: 6px; font-size: 13px; font-weight: 600;
    color: var(--accent); text-decoration: none; }
  .ratings-off { align-self: center; margin-left: 6px; font-size: 13px; color: var(--muted); }
```

- [ ] **Step 3: Check it headless — including a departed cruise and an unavailable database**

```bash
rm -f "$TMPDIR/sel-check.db"
# Seed: one listed sailing rated 5, one viewed, and one that is not listed (rated 3).
N24 && node --input-type=module -e '
import { openSelections } from "./selections.js";
import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync("data/sailings.json", "utf8"));
const [a, b] = d.sailings.filter((s) => s.departureDate > new Date().toISOString().slice(0, 10));
const st = await openSelections(process.env.TMPDIR + "/sel-check.db");
st.setRating(a.id, 5, "2026-10-14T10:00:00Z", a);
st.recordView(b, "2026-10-14T11:00:00Z");
st.setRating("cunard:GONE1", 3, "2026-10-01T10:00:00Z", { ...a, id: "cunard:GONE1", itinerary: "A Departed Voyage" });
console.log("seeded", a.id, b.id);'
mkdir -p "$TMPDIR/not-a-db.db"
N24 && (PORT=3031 SELECTIONS_FILE="$TMPDIR/sel-check.db" node server.js > "$TMPDIR/s.log" 2>&1 &)
N24 && (PORT=3032 SELECTIONS_FILE="$TMPDIR/not-a-db.db" node server.js > "$TMPDIR/s2.log" 2>&1 &) && sleep 2
cat > "$TMPDIR/check-mine.mjs" <<'EOF'
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/package.json')('puppeteer');
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:3031/', { waitUntil: 'networkidle2' });
const r = await page.evaluate(async () => {
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const chip = [...document.querySelectorAll('.yearchip')].find((c) => c.textContent.startsWith('My cruises'));
  const chipText = chip.textContent;
  chip.click(); await wait(100);
  const cards = [...document.querySelectorAll('article.card')];
  const titles = cards.map((c) => c.querySelector('.title').textContent);
  const gone = cards.find((c) => c.classList.contains('unlisted'));
  gone.querySelector('[data-stars] button:nth-child(4)').click(); await wait(600);
  const sel = await (await fetch('/api/selections')).json();
  return {
    chipText, count: cards.length, titles,
    goneLabel: gone.querySelector('.gone')?.textContent, goneHasFlights: !!gone.querySelector('.flights-btn'),
    goneRating: sel.selections.find((x) => x.sailingId === 'cunard:GONE1').rating,
    tableLink: !!document.querySelector('.table-link[href="/mine"]'),
  };
});
console.log(JSON.stringify(r), errors.length ? 'ERRORS ' + errors.join('; ') : 'no page errors');
await page.goto('http://localhost:3032/', { waitUntil: 'networkidle2' });
console.log(JSON.stringify(await page.evaluate(() => ({
  cards: document.querySelectorAll('article.card').length,
  stars: document.querySelectorAll('[data-stars]').length,
  notice: document.querySelector('.ratings-off')?.textContent,
  mineChip: [...document.querySelectorAll('.yearchip')].some((c) => c.textContent.startsWith('My cruises')),
}))));
await browser.close();
EOF
N24 && node "$TMPDIR/check-mine.mjs"; pkill -f "node server.js"
```

Expected, first line: chip `My cruises 3`; 3 cards, the rated-5 one first, then the departed one (rated 3), then the viewed-only one; the departed card labelled `No longer listed`, `goneHasFlights: false`, its rating now `4`; `tableLink: true`; no page errors. Second line: cards > 0, `stars: 0`, a notice starting `Ratings are unavailable: Could not open`, `mineChip: false`.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Add the My cruises chip, with cruises no longer listed greyed out"
```

---

### Task 7: The `/mine` table

**Files:**
- Create: `public/mine.html`
- Modify: `server.js` (route `GET /mine`)

**Interfaces:**
- Consumes: `GET /api/dataset`, `GET /api/selections`, `PUT /api/selections/rating`.

- [ ] **Step 1: The route**

In `server.js`, after the `/` route:

```js
    if (req.method === 'GET' && (req.url === '/mine' || req.url === '/mine.html')) {
      const html = await readFile(join(PUBLIC_DIR, 'mine.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }
```

- [ ] **Step 2: The page**

Create `public/mine.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My cruises</title>
<style>
  :root { --bg: #f6f7f9; --panel: #fff; --ink: #16202b; --muted: #63707e; --line: #e2e6ea;
    --accent: #0b6d8f; --chip: #eef2f5; --up: #b3261e; --down: #1b7f4b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1418; --panel: #161d23; --ink: #e8edf1; --muted: #9aa8b4; --line: #26313a;
      --accent: #4bb3d4; --chip: #1e272f; --up: #ff8a80; --down: #6fdc9c; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { margin: 0 0 4px; font-size: 24px; }
  .sub { color: var(--muted); font-size: 14px; margin-bottom: 18px; }
  .sub a { color: var(--accent); font-weight: 600; text-decoration: none; }
  .box { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 880px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); white-space: nowrap; }
  th button { all: inherit; cursor: pointer; }
  th button[aria-sort]::after { content: " ▾"; }
  th button[aria-sort="ascending"]::after { content: " ▴"; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .gone { color: var(--muted); font-size: 13px; }
  .up { color: var(--up); font-size: 12px; } .down { color: var(--down); font-size: 12px; }
  .stars { display: flex; gap: 1px; }
  .star { background: none; border: 0; padding: 0 1px; font-size: 18px; line-height: 1; color: var(--muted); cursor: pointer; }
  .star.on { color: #e8a317; }
  .empty { padding: 40px 16px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <h1>My cruises</h1>
  <div class="sub" id="sub">Loading… · <a href="/">Back to search</a></div>
  <div class="box"><div id="table"></div></div>
</div>
<script type="module">
const $ = (q) => document.querySelector(q);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const money = (n, cur) => `$${Math.round(n).toLocaleString('en-US')}${cur && cur !== 'USD' ? ` ${cur}` : ''}`;
const day = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

let rows = [];
let sortKey = null;
let sortDir = -1;

const COLUMNS = [
  ['Date', (r) => r.s.departureDate],
  ['Line', (r) => r.s.line],
  ['Ship', (r) => r.s.ship],
  ['Itinerary', (r) => r.s.itinerary ?? ''],
  ['Stars', (r) => r.sel.rating ?? 0],
  ['Price then', (r) => r.sel.snapshot.price ?? 0],
  ['Price now', (r) => r.now?.price ?? Infinity],
  ['Views', (r) => r.sel.views],
  ['Last viewed', (r) => r.sel.lastViewed ?? ''],
];

/** The chip's order: rated first, highest first; then most recently viewed. */
const defaultOrder = (a, b) => (b.sel.rating ?? 0) - (a.sel.rating ?? 0)
  || String(b.sel.lastViewed ?? '').localeCompare(String(a.sel.lastViewed ?? ''));

function starsFor(r) {
  const group = el('div', { class: 'stars', role: 'group', 'aria-label': 'Your rating' });
  const paint = () => [...group.children].forEach((b, i) => {
    const on = i < (r.sel.rating ?? 0);
    b.className = on ? 'star on' : 'star';
    b.textContent = on ? '★' : '☆';
    b.setAttribute('aria-pressed', String(i + 1 === r.sel.rating));
  });
  for (let n = 1; n <= 5; n += 1) {
    const b = el('button', { type: 'button', 'aria-label': `Rate ${n} star${n === 1 ? '' : 's'}` });
    b.onclick = async () => {
      const rating = r.sel.rating === n ? null : n;
      const res = await fetch('/api/selections/rating', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: r.sel.sailingId, rating }),
      });
      const data = await res.json();
      if (!res.ok) { console.error('Rating not saved:', data.error); return; }
      if (data.selection) r.sel = data.selection;
      else { rows = rows.filter((x) => x !== r); draw(); return; }
      paint();
    };
    group.append(b);
  }
  paint();
  return group;
}

function draw() {
  const host = $('#table');
  host.textContent = '';
  if (rows.length === 0) {
    host.append(el('div', { class: 'empty', text: "Nothing here yet — open a cruise's View ↗ or ✈ Flights, or give it stars." }));
    return;
  }
  const getter = sortKey == null ? null : COLUMNS[sortKey][1];
  const sorted = [...rows].sort(getter
    ? (a, b) => { const x = getter(a); const y = getter(b); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; }
    : defaultOrder);

  const head = el('tr', {}, COLUMNS.map(([label], i) => {
    const b = el('button', { type: 'button', text: label });
    if (i === sortKey) b.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
    b.onclick = () => { sortDir = sortKey === i ? -sortDir : 1; sortKey = i; draw(); };
    return el('th', {}, b);
  }));

  const body = sorted.map((r) => {
    const link = safeUrl(r.s.url);
    const then = r.sel.snapshot.price;
    let nowCell;
    if (!r.now) nowCell = el('span', { class: 'gone', text: 'No longer listed' });
    else {
      const diff = then != null ? Math.round(r.now.price - then) : 0;
      nowCell = el('span', {}, money(r.now.price, r.now.currency),
        diff ? el('div', { class: diff > 0 ? 'up' : 'down', text: `${diff > 0 ? '+' : '−'}$${Math.abs(diff).toLocaleString('en-US')}` }) : null);
    }
    return el('tr', {},
      el('td', { text: day(r.s.departureDate) }),
      el('td', { text: r.s.line }),
      el('td', { text: r.s.ship }),
      el('td', {}, link ? el('a', { href: link, target: '_blank', rel: 'noopener', text: r.s.itinerary ?? 'Cruise' }) : (r.s.itinerary ?? 'Cruise')),
      el('td', {}, starsFor(r)),
      el('td', { class: 'num', text: then != null ? money(then, r.sel.snapshot.currency) : '' }),
      el('td', { class: 'num' }, nowCell),
      el('td', { class: 'num', text: String(r.sel.views) }),
      el('td', { text: day(r.sel.lastViewed) }));
  });

  host.append(el('table', {}, el('thead', {}, head), el('tbody', {}, body)));
}

async function boot() {
  const [dres, sres] = await Promise.all([fetch('/api/dataset'), fetch('/api/selections')]);
  const sdata = await sres.json();
  if (!sres.ok) { $('#sub').firstChild.textContent = `Ratings are unavailable: ${sdata.error} · `; return; }
  const listed = dres.ok ? (await dres.json()).sailings : [];
  const byId = new Map(listed.map((s) => [s.id, s]));
  rows = sdata.selections.map((sel) => {
    const now = byId.get(sel.sailingId) ?? null;
    return { sel, now, s: now ?? sel.snapshot };
  });
  $('#sub').firstChild.textContent = `${rows.length} viewed or rated · `;
  draw();
}

boot();
</script>
</body>
</html>
```

- [ ] **Step 3: Check it headless**

Seed a scratch database (one listed sailing rated 5, one viewed, one no longer listed rated 3) and start a keyless server on 3031:

```bash
rm -f "$TMPDIR/sel-check.db"
N24 && node --input-type=module -e '
import { openSelections } from "./selections.js";
import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync("data/sailings.json", "utf8"));
const [a, b] = d.sailings.filter((s) => s.departureDate > new Date().toISOString().slice(0, 10));
const st = await openSelections(process.env.TMPDIR + "/sel-check.db");
st.setRating(a.id, 5, "2026-10-14T10:00:00Z", a);
st.recordView(b, "2026-10-14T11:00:00Z");
st.setRating("cunard:GONE1", 3, "2026-10-01T10:00:00Z", { ...a, id: "cunard:GONE1", itinerary: "A Departed Voyage" });
console.log("seeded", a.id, b.id);'
N24 && (PORT=3031 SELECTIONS_FILE="$TMPDIR/sel-check.db" node server.js > "$TMPDIR/s.log" 2>&1 &) && sleep 2
cat > "$TMPDIR/check-table.mjs" <<'EOF'
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/package.json')('puppeteer');
const browser = await puppeteer.launch();
const page = await browser.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
for (const [w, h] of [[1440, 900], [800, 600], [390, 800]]) {
  await page.setViewport({ width: w, height: h });
  await page.goto('http://localhost:3031/mine', { waitUntil: 'networkidle2' });
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const rowsText = () => [...document.querySelectorAll('tbody tr')].map((tr) => tr.children[3].textContent);
    const first = rowsText();
    const gone = [...document.querySelectorAll('tbody tr')].some((tr) => tr.textContent.includes('No longer listed'));
    [...document.querySelectorAll('th button')].find((b) => b.textContent === 'Date').click(); await wait(50);
    const byDate = [...document.querySelectorAll('tbody tr')].map((tr) => tr.children[0].textContent);
    return { first, gone, byDate, pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth };
  });
  console.log(`${w}x${h}`, JSON.stringify(r));
  await page.screenshot({ path: `${process.env.TMPDIR}/mine-${w}.png` });
}
console.log(errors.length ? 'ERRORS ' + errors.join('; ') : 'no page errors');
await browser.close();
EOF
N24 && node "$TMPDIR/check-table.mjs"; pkill -f "node server.js"
```

Expected at each size: 3 rows, the rated-5 itinerary first and "A Departed Voyage" second; `gone: true`; `byDate` ascending after one click; `pageScrollsSideways: false` (the table scrolls inside its box); no page errors. Look at the three screenshots.

- [ ] **Step 4: Commit**

```bash
git add public/mine.html server.js
git commit -m "Add the My cruises table at /mine"
```

---

### Task 8: Search by rating and by viewed

**Files:**
- Modify: `search.js`, `brain.js`, `server.js`
- Test: `test/search.test.js`, `test/brain.test.js`

**Interfaces:**
- Consumes: `selectionMap(store)` (Task 3).
- Produces: filter fields `minRating` (1–5|null), `hideRatedAtMost` (1–5|null), `viewed` (boolean|null); `searchSailings(sailings, filter, selections = {})`; `usesSelections(filter): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/search.test.js` (add `usesSelections` to its `search.js` import):

```js
const rated = (id) => ({ id, line: 'L', ship: 'S', destination: 'alaska', departurePort: 'P',
  departureDate: '2027-06-01', nights: 7, price: 500, cabin: 'interior' });
const pool = ['a', 'b', 'c', 'd'].map(rated);
const mine = { a: { rating: 5, views: 2 }, b: { rating: 2, views: 0 }, c: { rating: null, views: 1 } };
const ids = (list) => list.map((s) => s.id);

test('minRating keeps only sailings rated that high', () => {
  assert.deepEqual(ids(searchSailings(pool, { minRating: 4 }, mine)), ['a']);
  assert.deepEqual(ids(searchSailings(pool, { minRating: 2 }, mine)), ['a', 'b']);
});

test('hideRatedAtMost drops low ratings and keeps unrated sailings', () => {
  assert.deepEqual(ids(searchSailings(pool, { hideRatedAtMost: 2 }, mine)), ['a', 'c', 'd']);
});

test('viewed true and false', () => {
  assert.deepEqual(ids(searchSailings(pool, { viewed: true }, mine)), ['a', 'c']);
  assert.deepEqual(ids(searchSailings(pool, { viewed: false }, mine)), ['b', 'd']);
});

test("'ones I haven't seen' with nothing viewed yet is everything, not nothing", () => {
  assert.deepEqual(ids(searchSailings(pool, { viewed: false }, {})), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(searchSailings(pool, { viewed: false })), ['a', 'b', 'c', 'd']);
});

test('rating filters combine with the others', () => {
  const pricey = [...pool, { ...rated('e'), price: 3000 }];
  const withE = { ...mine, e: { rating: 5, views: 1 } };
  assert.deepEqual(ids(searchSailings(pricey, { minRating: 5, maxPrice: 1000 }, withE)), ['a']);
});

test('the rating fields count as constraints and are described', () => {
  assert.equal(hasNoConstraints({ viewed: false }), false);
  assert.equal(hasNoConstraints({ minRating: 4 }), false);
  assert.equal(describeFilter({ minRating: 4 }), 'rated 4★ or more');
  assert.equal(describeFilter({ hideRatedAtMost: 2 }), 'hiding 2★ or less');
  assert.equal(describeFilter({ viewed: false, destination: 'alaska' }), 'Alaska and not yet viewed');
  assert.equal(describeFilter({ viewed: true }), 'viewed');
  assert.equal(usesSelections({ viewed: false }), true);
  assert.equal(usesSelections({ destination: 'alaska' }), false);
});
```

(If `hasNoConstraints` or `describeFilter` are not already imported in that file, add them.)

Append to `test/brain.test.js`:

```js
test('the model can express ratings and views, and only whole stars 1 to 5', () => {
  const schema = buildSchema(values);
  for (const f of ['minRating', 'hideRatedAtMost']) {
    assert.deepEqual(schema.properties[f], {
      anyOf: [{ type: 'integer', enum: [1, 2, 3, 4, 5] }, { type: 'null' }],
    });
    assert.ok(schema.required.includes(f));
  }
  assert.deepEqual(schema.properties.viewed, { anyOf: [{ type: 'boolean' }, { type: 'null' }] });
});

test("the prompt explains the shopper's own ratings", () => {
  const prompt = buildSystemPrompt({ from: '2027-04-24', to: '2027-09-30' });
  assert.match(prompt, /minRating/);
  assert.match(prompt, /hideRatedAtMost/);
  assert.match(prompt, /haven't seen/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `N24 && node --test test/search.test.js test/brain.test.js 2>&1 | grep -E "^not ok|does not provide|^# (pass|fail)"`
Expected: FAIL — `usesSelections` not exported (search), and the two brain tests.

- [ ] **Step 3: Implement**

`search.js` — signature and the new conditions, before `return true;`:

```js
export function searchSailings(sailings, filter = {}, selections = {}) {
```

```js
    // The shopper's own ratings and views (selections.js), by sailing id.
    const mine = selections[s.id];
    if (filter.minRating != null && !((mine?.rating ?? 0) >= filter.minRating)) return false;
    if (filter.hideRatedAtMost != null && mine?.rating != null && mine.rating <= filter.hideRatedAtMost) return false;
    if (filter.viewed === true && !((mine?.views ?? 0) > 0)) return false;
    if (filter.viewed === false && (mine?.views ?? 0) > 0) return false;
```

Add `'minRating', 'hideRatedAtMost', 'viewed'` to `CONSTRAINTS`. After `hasNoConstraints`:

```js
/** True when the filter asks about the shopper's ratings or views. */
export function usesSelections(filter = {}) {
  return ['minRating', 'hideRatedAtMost', 'viewed'].some((k) => filter[k] != null);
}
```

In `describeFilter`, before `if (parts.length === 0)`:

```js
  if (filter.minRating != null) parts.push(`rated ${filter.minRating}★ or more`);
  if (filter.hideRatedAtMost != null) parts.push(`hiding ${filter.hideRatedAtMost}★ or less`);
  if (filter.viewed === true) parts.push('viewed');
  if (filter.viewed === false) parts.push('not yet viewed');
```

`brain.js` — in `buildSchema`'s `properties`, after `dateTo`:

```js
    minRating: oneOf([1, 2, 3, 4, 5], 'integer'),
    hideRatedAtMost: oneOf([1, 2, 3, 4, 5], 'integer'),
    viewed: orNull({ type: 'boolean' }),
```

and in `buildSystemPrompt`'s Vocabulary list, after the "next January" line:

```
- The shopper has rated some cruises 1–5 stars and viewed some. "my 4- and 5-star
  cruises", "rated 4 or more" mean minRating 4; "ones I loved", "my favourites" mean
  minRating 5. "hide the ones I rated 2 or less", "nothing I disliked" mean
  hideRatedAtMost 2. "ones I haven't seen", "new to me" mean viewed false; "ones I've
  looked at" means viewed true. Words like "best" or "top-rated" are NOT the shopper's
  ratings — leave these fields null unless the shopper speaks of their own.
```

`server.js` — import `selectionMap` from `./selections.js` and `usesSelections` from `./search.js`; in `/api/search`, replace the `results` and `candidates` lines and the `message` field:

```js
      const mine = selectionMap(selections);
      // Asked about ratings while they can't be read: say so, rather than ignore the ask.
      const ratingsMissing = !selections.ok && usesSelections(filter);

      const results = understoodNothing || ratingsMissing ? [] : searchSailings(view.sailings, filter, mine);
```

```js
      const candidates = understoodNothing
        ? []
        : searchSailings(view.sailings, { ...filter, minPrice: null, maxPrice: null }, mine);
```

```js
        message: ratingsMissing
          ? 'Ratings are unavailable right now.'
          : results.length === 0 ? emptyMessage(filter) : null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `N24 && npm test 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'`
Expected: 269 pass, 0 fail.

- [ ] **Step 5: Real searches (~$0.002 each)**

Seed a scratch database (one listed sailing rated 5, one viewed, one no longer listed rated 3), start a keyed server on 3031, and ask:

```bash
rm -f "$TMPDIR/sel-check.db"
N24 && node --input-type=module -e '
import { openSelections } from "./selections.js";
import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync("data/sailings.json", "utf8"));
const [a, b] = d.sailings.filter((s) => s.departureDate > new Date().toISOString().slice(0, 10));
const st = await openSelections(process.env.TMPDIR + "/sel-check.db");
st.setRating(a.id, 5, "2026-10-14T10:00:00Z", a);
st.recordView(b, "2026-10-14T11:00:00Z");
st.setRating("cunard:GONE1", 3, "2026-10-01T10:00:00Z", { ...a, id: "cunard:GONE1", itinerary: "A Departed Voyage" });
console.log("seeded", a.id, b.id);'
N24 && (PORT=3031 SELECTIONS_FILE="$TMPDIR/sel-check.db" node --env-file-if-exists=.env server.js --check-3031 > "$TMPDIR/s.log" 2>&1 &) && sleep 2
for q in "my 5-star cruises" "Alaska ones I haven't seen" "hide the ones I rated 3 or less" "the best-rated cruises in the Caribbean"; do
  curl -s -X POST localhost:3031/api/search -H 'content-type: application/json' -d "{\"q\":\"$q\"}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({q:process.argv[1],understood:j.understood,n:j.results?.length,minRating:j.filter?.minRating,hide:j.filter?.hideRatedAtMost,viewed:j.filter?.viewed}))})' "$q"
done
pkill -f "server.js --check-3031"
```

Expected: "my 5-star cruises" → `minRating 5`, 1 result; "Alaska ones I haven't seen" → Alaska + `viewed false`; "hide … 3 or less" → `hideRatedAtMost 3`; "the best-rated … Caribbean" → Caribbean with **all three fields null** (not the shopper's ratings). A wrong reading is a prompt problem: adjust the vocabulary lines, re-run Step 4, then this step.

- [ ] **Step 6: Commit**

```bash
git add search.js brain.js server.js test/search.test.js test/brain.test.js
git commit -m "Search by your ratings and by what you've viewed"
```

---

### Task 9: Docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: `CLAUDE.md`**

- Architecture list: add ``- `selections.js` — viewed and rated sailings in `data/selections.db` (`node:sqlite`); the only file that touches the database.``
- Status: add a **My cruises** paragraph — what counts as a view, 1–5 stars, the chip and `/mine`, the three search fields, snapshots for cruises no longer listed, `SELECTIONS_FILE` for checks, `npm run export-selections` for backups, and that ratings are unavailable (not fatal) on Node < 24.15. Update the test count from `npm test`.
- Running it: add `npm run export-selections   # a readable JSON copy of your ratings`.

- [ ] **Step 2: `README.md`**

A short "My cruises" section: rate with stars, what counts as viewed, the chip and the table, the searches ("my 5-star cruises", "ones I haven't seen"), that ratings live only on this machine in `data/selections.db`, and the export command. Note Node 24.15+ and `nvm use` where setup is described.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Record My cruises in the project notes"
```

- [ ] **Step 4: Peter's live check**

Hand over: `nvm use && npm run serve`, then rate two cruises, open one's ✈ panel, click My cruises, open Table view, and search "my 5-star cruises". His real `data/selections.db` is created on first use.
