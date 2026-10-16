# Deployment, Login and a Refresh Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ai-cruises runs on Peter's Coolify server at ai-cruises.peter-jones.org behind a login, while a "Refresh data" button on his Mac scrapes, uploads the new `sailings.json` to the server and copies the server's ratings back.

**Architecture:** One codebase, two roles chosen by settings. The server (`HOST=0.0.0.0`, login on) accepts uploads and ratings requests on `/api/sync/*` with a shared key. The Mac (`127.0.0.1`, no login, `SYNC_URL` + `SYNC_KEY`) runs the scrape as a child process, streams its lines to a panel, then uploads and pulls. Every new piece is a plain module with a pure-ish function the server calls and the tests call directly (the pattern `handleSelections` already uses); `server.js` only wires them.

**Tech Stack:** Node 24 (ESM), `node:crypto`, `node:zlib`, `node:sqlite`, `node:child_process`, `node --test`, Caddy 2.11 for local HTTPS checks, Docker. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-deployment-design.md` — read it first.

### Planned departures from the spec

1. **"Show the new data" reloads the page** (`location.reload()`) rather than re-fetching
   `/api/dataset` and redrawing in place. The page's boot wires event handlers once; running it
   twice would double them. A reload costs the current search and scroll — acceptable after a
   25-minute refresh, and far less code.
2. **`/healthz` answers 200 when there is no data yet.** The spec says 503 "if ratings or data
   cannot be read". On the first deploy the volume is empty until the first upload; a 503 would
   make Coolify mark that deploy unhealthy. Absent data is "ok — no data yet"; unreadable or
   corrupt data is 503.
3. **HSTS is never sent to `localhost`/`127.0.0.1`**, even from a container. Browsers can pin
   HSTS for `localhost`, which would force every later `http://localhost:3030` to HTTPS and break
   the Mac's copy. It is sent when deployed and the request's host is a real name.
4. **Login settings half-set is a startup error anywhere**, not only on a public `HOST`: one of
   `JWT_SECRET`/`LOGIN_PASSWORD_HASH` without the other is always a mistake.
5. **`DATA_DIR` setting** (new): the server, the scrape and the sync commands read and write
   `sailings.json` under it (default `./data/`). The spec's checks need a scratch data folder for
   the second copy on port 3031, and a Refresh run in a check must never write Peter's
   `data/sailings.json`.
6. **`REFRESH_ARGS` setting** (new, checks only): extra flags for the Refresh's scrape, e.g.
   `--site viking --limit 5`, so the end-to-end check takes a minute, not 25.
7. **`/api/status`** (new, locked): `{ login, mirror, ratingsCopiedAt }` — tells the pages whether
   to show "Log out" and the mirror note.
8. **`Cache-Control: no-store`** on pages and API answers when login is on, so Back after
   logging out does not show cached pages. Not in the spec; found writing Review Focus.

## Global Constraints

- Node 24, ESM. Dependencies stay `puppeteer` and `@anthropic-ai/sdk` — nothing added.
- `brain.js` is the only file that calls a model; `selections.js` the only file that touches the database.
- Adapters are standalone files and report through `onProgress`; only `progress.js` prints a scrape's progress.
- Passwords: 12+ characters. `JWT_SECRET` and `SYNC_KEY`: 32+ characters. Session: 30 days. Guessing limit: 5 failures per address per 15 minutes.
- Cookie: `session=…; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`, always `Secure`.
- JWT: HS256 only; claims `iat`, `exp`, `pwf` (first 16 hex of SHA-256 of `LOGIN_PASSWORD_HASH`).
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
- Upload limits: 20 MB compressed, 50 MB unpacked; every other `/api/` route keeps 64 KB.
- An upload with fewer than half the server's sailings is refused unless forced.
- Mirror note text: `Ratings copied from the server at <time> — changes here aren't kept`.
- Never touch Peter's real `data/sailings.json` or `data/selections.db` in checks: a second copy on `PORT=3031` with `DATA_DIR` and `SELECTIONS_FILE` in the session scratchpad. Never run `node scrape.js` without `--dry-run`, except through the Refresh check's `REFRESH_ARGS` into a scratch `DATA_DIR`.
- Secrets (`.env` values, keys, hashes) never reach logs, fixtures, test output or commits. Tests make their own.
- Commit; never push — Peter pushes. Run tests on Node 24: `source ~/.nvm/nvm.sh >/dev/null && nvm use >/dev/null && npm test`; the summary lines start `ℹ`.
- Temporary files go in the session scratchpad (`$SCRATCH` below), never `/tmp` or `$TMPDIR`.

## Review Focus

1. **First deploy with an empty volume** — the server starts, `/healthz` is 200, login works, and `/api/dataset` says to upload from the Mac (`npm run upload-data`), not "run `node scrape.js`". (Task 4: dataset message test; Task 6: health test, container check.)
2. **Logging out, then pressing Back** — pages and API answers carry `Cache-Control: no-store` while login is on, so nothing is shown from cache. (Task 3: headers test.)
3. **A ratings push bigger than 64 KB** (~100 saved cruises with snapshots) — the sync routes have their own limit. (Task 4: "a 500-row push is accepted".)
4. **A Refresh whose scrape cannot start** (bad path, crash on import) — the panel says so; it does not stay "Refreshing…" forever. (Task 5: spawn error test.)
5. **An upload while a page is loading the dataset** — the current file is copied to `.previous` and the new one renamed over it, so `sailings.json` never goes missing in between. (Task 4: "the current file is never absent" test.)

---

### Task 1: Princess — a fresh tab per ship

**Files:**
- Modify: `sites/princess.js` (`loadAllCards`, `fetchListingPages`, imports)
- Modify: `scrape.js` (bot-wall snapshot)
- Test: `test/princess.test.js`

**Interfaces:**
- Produces: `fetchListingPages(page, { limit, onProgress = () => {}, pause = politeDelay }) → Promise<string[]>`. Uses `page.browser()` only. An error thrown for a ship carries `err.pageHtml` (the failing tab's HTML, or null).

- [ ] **Step 1: Write the failing tests** — append to `test/princess.test.js` (add `fetchListingPages` to its import from `../sites/princess.js`, and `readFileSync` from `node:fs` if not imported):

```js
const noPause = async () => {};
const RESULTS_PAGE = `<html><head><title>Cruise search results</title></head><body>${'<div class="card">sailing</div>'.repeat(60)}</body></html>`;
const SHIP_CODES = JSON.parse(readFileSync(new URL('./fixtures/princess-ships-ref.json', import.meta.url), 'utf8')).ships.map((s) => s.id);

/** A browser whose tabs remember what happened to them. */
function fakeBrowser({ failOnShip = null, html = RESULTS_PAGE } = {}) {
  const b = { tabs: [] };
  b.newPage = async () => {
    const tab = {
      url: null, closed: false,
      setUserAgent: async () => {}, setViewport: async () => {},
      goto: async (url) => {
        tab.url = url;
        if (failOnShip && url.endsWith(`ship=${failOnShip}`)) throw new Error('Navigation timeout of 60000 ms exceeded');
      },
      evaluate: async () => 20,
      content: async () => html,
      close: async () => { tab.closed = true; },
    };
    b.tabs.push(tab);
    return tab;
  };
  return b;
}
const sharedPage = (browser) => ({
  browser: () => browser,
  goto: async () => { throw new Error('the shared page must not load results pages'); },
});

test('each ship gets its own tab, closed afterwards', async () => {
  const browser = fakeBrowser();
  const pages = await fetchListingPages(sharedPage(browser), { limit: 60, pause: noPause });
  assert.equal(pages.length, 3);
  assert.equal(browser.tabs.length, 3);
  assert.ok(browser.tabs.every((t) => t.closed));
  assert.deepEqual(browser.tabs.map((t) => t.url.split('ship=')[1]), SHIP_CODES.slice(0, 3));
});

test('a ship that fails still closes its tab, and the error carries the page', async () => {
  const browser = fakeBrowser({ failOnShip: SHIP_CODES[1] });
  await assert.rejects(fetchListingPages(sharedPage(browser), { limit: 60, pause: noPause }), (err) => {
    assert.match(err.message, /Navigation timeout/);
    assert.equal(err.pageHtml, RESULTS_PAGE);
    return true;
  });
  assert.equal(browser.tabs.length, 2);
  assert.ok(browser.tabs.every((t) => t.closed));
});

test('a bot wall closes its tab and is reported with the page', async () => {
  const browser = fakeBrowser({ html: '<html><title>Access Denied</title></html>' });
  await assert.rejects(fetchListingPages(sharedPage(browser), { limit: 20, pause: noPause }), (err) => {
    assert.equal(err.name, 'BotWallError');
    assert.match(err.pageHtml, /Access Denied/);
    return true;
  });
  assert.ok(browser.tabs.every((t) => t.closed));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/princess.test.js`
Expected: the three new tests FAIL — the first with "the shared page must not load results pages" (today's code navigates the shared page); `err.name` check may also show `BotWallError` is fine but `pageHtml` is undefined.

- [ ] **Step 3: Implement** — in `sites/princess.js`:

Change the browser import to `import { politeDelay, detectBotWall, newPage } from '../browser.js';`

Replace `loadAllCards` and `fetchListingPages` with:

```js
/**
 * Scrolls until the card count stops growing, then returns the rendered HTML.
 *
 * The list lazy-loads: 10 cards on arrival, 20 after a scroll. Bounded at 15
 * iterations so a site change cannot spin forever, and every scroll is spaced by
 * a polite pause.
 */
async function loadAllCards(page, pause) {
  let previous = -1;
  for (let i = 0; i < 15; i += 1) {
    const count = await page.evaluate(
      () => document.querySelectorAll('.product-details-date-wrapper').length,
    );
    if (count === previous) break;
    previous = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await pause(2500);
  }
  return page.content();
}

/**
 * One rendered results page per ship, each in its own tab.
 *
 * A fresh tab per ship, closed afterwards: one tab reused for all 17 results pages kept
 * every page's scripts in memory — 3.3 GB by the last ship (spike, 2026-10-16), against
 * ~1.4 GB this way, with the same sailings.
 *
 * @param {import('puppeteer').Page} page - only its browser is used
 * @param {{limit: number, onProgress?: Function, pause?: Function}} options - `limit` caps
 *   how many SHIPS are visited (~20 sailings each), so a small limit means a short run.
 * @returns {Promise<string[]>}
 */
export async function fetchListingPages(page, { limit, onProgress = () => {}, pause = politeDelay }) {
  const codes = await shipCodes();
  const wanted = Number.isFinite(limit)
    ? codes.slice(0, Math.max(1, Math.ceil(limit / 20)))
    : codes;
  const browser = page.browser();
  const pages = [];

  for (const [i, code] of wanted.entries()) {
    onProgress(`ship ${i + 1}/${wanted.length}`);
    const url = `${RESULTS_URL}?ship=${code}`;
    const tab = await newPage(browser);
    try {
      await tab.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
      await pause();

      const html = await loadAllCards(tab, pause);
      const wall = detectBotWall(html);
      if (wall) throw new BotWallError(wall, url);

      pages.push(html);
    } catch (err) {
      // scrape.js saves the page that failed, but this tab is about to close: carry it.
      err.pageHtml ??= await tab.content().catch(() => null);
      throw err;
    } finally {
      await tab.close();
    }
  }

  return pages;
}
```

In `scrape.js`, the bot-wall branch of the adapter `catch`, change
`const path = await snapshotFailure(await page.content(), \`${adapter.name}-wall\`);` to:

```js
        // An adapter that opens its own tabs (Princess) closes them; the error carries the page.
        const path = await snapshotFailure(err.pageHtml ?? await page.content(), `${adapter.name}-wall`);
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/princess.test.js && npm test`
Expected: all Princess tests pass; whole suite passes (`ℹ fail 0`).

- [ ] **Step 5: A real dry run of Princess**

Run: `node scrape.js --site princess --dry-run 2>&1 | grep -E '^princess|DRY RUN|failure'`
Expected: `princess: ship 17/17` progress, `princess: 9x sailings (m:ss)`, `DRY RUN — 9x sailings`, no failure line. (A dry run writes nothing.)

- [ ] **Step 6: Commit**

```bash
git add sites/princess.js scrape.js test/princess.test.js
git commit -m "Give each Princess ship its own tab, so the scrape stays near 1.4 GB, not 3.3 GB"
```

---

### Task 2: Security headers, and the pages' scripts in files

**Files:**
- Create: `headers.js`, `public/index.js`, `public/mine.js`
- Modify: `public/index.html`, `public/mine.html` (inline module scripts → `src`), `server.js` (set headers on every response)
- Test: `test/headers.test.js`, `test/pages.test.js`

**Interfaces:**
- Produces: `securityHeaders({ deployed: boolean, host: string, login: boolean }) → Record<string, string>` and `CSP` (string), from `headers.js`. Task 3 passes the real `login`/`deployed`; this task passes `login: false`, `deployed: false`.

- [ ] **Step 1: Write the failing tests**

`test/headers.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders, CSP } from '../headers.js';

test('every response gets the content policy, nosniff and no referrer', () => {
  const h = securityHeaders({ deployed: false, host: 'localhost:3030', login: false });
  assert.equal(h['content-security-policy'], CSP);
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /script-src[^;]*unsafe-inline/);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /img-src 'self' https: data:/);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['referrer-policy'], 'no-referrer');
});

test('HSTS only when deployed, and never to localhost', () => {
  const on = securityHeaders({ deployed: true, host: 'ai-cruises.peter-jones.org', login: true });
  assert.equal(on['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.equal(securityHeaders({ deployed: false, host: 'ai-cruises.peter-jones.org', login: true })['strict-transport-security'], undefined);
  for (const host of ['localhost:8443', '127.0.0.1:3030', 'localhost']) {
    assert.equal(securityHeaders({ deployed: true, host, login: true })['strict-transport-security'], undefined, host);
  }
});

test('with login on, nothing is cached — Back after logging out shows nothing', () => {
  assert.equal(securityHeaders({ deployed: true, host: 'x.org', login: true })['cache-control'], 'no-store');
  assert.equal(securityHeaders({ deployed: false, host: 'localhost', login: false })['cache-control'], undefined);
});
```

`test/pages.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const PUBLIC = new URL('../public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUBLIC), 'utf8');
const files = readdirSync(PUBLIC);

test('pages load every script from a file (the content policy allows no inline script)', () => {
  for (const f of files.filter((n) => n.endsWith('.html'))) {
    const html = read(f);
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1]));
    assert.deepEqual(inline.map((m) => m[0]), [], `${f} has an inline script`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${f} has an inline event handler`);
    assert.doesNotMatch(html, /javascript:/i, `${f} has a javascript: URL`);
  }
});

test('scripts never write inline event handlers into markup', () => {
  for (const f of files.filter((n) => n.endsWith('.js'))) {
    assert.doesNotMatch(read(f), /\son[a-z]+=\\?["']/, `${f} writes an inline handler`);
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/headers.test.js test/pages.test.js`
Expected: FAIL — `Cannot find module '../headers.js'`; `index.html has an inline script`.

- [ ] **Step 3: Write `headers.js`**

```js
/**
 * Security headers on every response — what helmet gives MyFinancesWeb, by hand (no
 * dependencies here). The pages load scripts from files only, so the policy needs no
 * 'unsafe-inline' for scripts; styles stay inline. Photos are hotlinked from the lines'
 * own sites, hence img-src https:.
 */
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:", "connect-src 'self'", "font-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * @param {{deployed: boolean, host: string, login: boolean}} at - deployed: HOST is public;
 *   host: the request's Host header; login: the login is on.
 */
export function securityHeaders({ deployed, host, login }) {
  const h = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  // Never to localhost: a browser that pinned HSTS for localhost would force the Mac's own
  // http://localhost:3030 to HTTPS from then on.
  if (deployed && !LOCAL.test(host ?? '')) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  // Logged out, Back must not show the pages or answers from the browser's cache.
  if (login) h['cache-control'] = 'no-store';
  return h;
}
```

- [ ] **Step 4: Move the inline scripts into files** — mechanical, nothing in them changes:

```bash
python3 - <<'EOF'
import re
for page, js in (('public/index.html', 'public/index.js'), ('public/mine.html', 'public/mine.js')):
    html = open(page).read()
    m = re.search(r'<script type="module">\n(.*?)</script>', html, re.S)
    assert m and html.count('<script type="module">') == 1, page
    open(js, 'w').write(m.group(1))
    name = js.split('/')[-1]
    open(page, 'w').write(html[:m.start()] + f'<script type="module" src="/{name}"></script>' + html[m.end():])
    print(page, '->', js, len(m.group(1).splitlines()), 'lines')
EOF
```

Expected: `public/index.html -> public/index.js 7xx lines`, `public/mine.html -> public/mine.js 1xx lines`. `import { priceFor } from '/search.js';` stays the first line of `public/index.js` (the server serves `/search.js`).

- [ ] **Step 5: Set the headers in `server.js`** — add the import, and at the very top of the request handler (first line inside `createServer(async (req, res) => { try {`):

```js
import { securityHeaders } from './headers.js';
```

```js
    // Before any route answers: setHeader values merge into every writeHead below.
    for (const [name, value] of Object.entries(securityHeaders({ deployed: false, host: req.headers.host, login: false }))) {
      res.setHeader(name, value);
    }
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: all pass, including the 5 new ones.

- [ ] **Step 7: Headless check — both pages work under the policy**

Start a scratch copy:

```bash
SCRATCH=<session scratchpad>; mkdir -p "$SCRATCH/deploy-check"
cp data/sailings.json "$SCRATCH/deploy-check/sailings.json"   # a read-only copy
PORT=3031 SELECTIONS_FILE="$SCRATCH/deploy-check/selections.db" node server.js > "$SCRATCH/deploy-check/server.log" 2>&1 &
```

(`DATA_DIR` arrives in Task 4; until then the scratch copy reads the real `data/sailings.json` read-only, which is allowed — it never writes it.)

Write `$SCRATCH/deploy-check/csp-check.mjs`: puppeteer (via `createRequire('/Users/pjones/Projects/ai-cruises/package.json')('puppeteer')`, `protocolTimeout: 30000`, a normal Chrome user agent), a document-level click listener that `preventDefault`s so View ↗ never navigates, and `page.on('console')` plus `securitypolicyviolation` events collected via `page.evaluateOnNewDocument(() => document.addEventListener('securitypolicyviolation', (e) => console.log('CSP', e.violatedDirective, e.blockedURI)))`. It opens `http://localhost:3031/`, waits for `.card`, types "Alaska balcony" into `#q` and submits, clicks a star on the first card, opens the first card's ✈ Flights and closes it, then opens `/mine`. It prints the count of CSP violations, the card count, and whether the `content-security-policy` response header is present.

Run: `node "$SCRATCH/deploy-check/csp-check.mjs"`
Expected: `CSP violations: 0`, cards > 0, `/mine` table rows ≥ 1, header present. Stop the copy: `pkill -f "PORT=3031" ; pkill -f "node server.js"` only if it is the scratch one (check `lsof -i :3031`).

- [ ] **Step 8: Commit**

```bash
git add headers.js server.js public/index.html public/index.js public/mine.html public/mine.js test/headers.test.js test/pages.test.js
git commit -m "Send security headers, and load the pages' scripts from files so the policy forbids inline scripts"
```

---

### Task 3: Login

**Files:**
- Create: `auth.js`, `public/login.html`, `public/login.js`, `public/session.js`, `tools/hash-password.js`, `tools/make-key.js`
- Modify: `server.js` (gate, login/logout/status routes, startup check), `guard.js` (body limit parameter), `public/index.html`, `public/mine.html` (account slot), `public/index.js`, `public/mine.js` (import session.js), `package.json` (scripts)
- Test: `test/auth.test.js`, `test/guard.test.js`

**Interfaces:**
- Consumes: `securityHeaders` from Task 2.
- Produces (from `auth.js`):
  - `hashPassword(password: string, salt?: Buffer) → string` (`scrypt$32768$8$1$<salt>$<hash>`, base64url)
  - `verifyPassword(password: string, stored: string) → boolean`
  - `isPasswordHash(stored: string) → boolean`
  - `checkNewPassword(a: string, b: string) → string|null` (error text)
  - `signToken({ secret, passwordHash, now?: number /* ms */ }) → string`
  - `verifyToken(token, { secret, passwordHash, now?: number }) → object|null` (claims)
  - `sessionCookie(token) → string`, `clearedCookie() → string`, `readCookie(header, name) → string|null`
  - `createLimiter({ max = 5, windowMs = 900000, now = Date.now }) → { blocked(addr) → ms, fail(addr), succeed(addr) }`
  - `tooManyMessage(ms) → string`
  - `clientAddress({ socketAddress, forwardedFor, trustProxy }) → string`
  - `authConfig(env) → { on: boolean, secret, passwordHash, problems: string[] }`
  - `startupProblems({ env, host, selections }) → string[]`
  - `isLocalHost(host) → boolean`
  - `isOpenPath(method, path) → boolean`
- Produces (from `guard.js`): `checkRequest({ method, headers, maxBody = MAX_BODY })`, `readRaw(req, maxBody) → Promise<Buffer>`; `readBody(req, maxBody = MAX_BODY)` unchanged in meaning.
- Produces: `GET /api/status → { login: boolean, mirror: false, ratingsCopiedAt: null }` (Task 4 fills `mirror`/`ratingsCopiedAt`). `#account` and `#mirror-note` elements on both pages; `public/session.js` fills them.

- [ ] **Step 1: Write the failing tests** — `test/auth.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  hashPassword, verifyPassword, isPasswordHash, checkNewPassword, signToken, verifyToken,
  sessionCookie, clearedCookie, readCookie, createLimiter, tooManyMessage, clientAddress,
  authConfig, startupProblems, isOpenPath,
} from '../auth.js';

const SECRET = 's'.repeat(40);
const HASH = hashPassword('correct horse battery');
const DAY = 86_400_000;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const forge = (header, claims, secret = SECRET) => {
  const head = `${b64(header)}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
};
const claimsFor = (hash = HASH, now = Date.now()) => JSON.parse(Buffer.from(signToken({ secret: SECRET, passwordHash: hash, now }).split('.')[1], 'base64url'));

test('a password hash verifies its own password and nothing else', () => {
  assert.ok(isPasswordHash(HASH));
  assert.match(HASH, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.ok(verifyPassword('correct horse battery', HASH));
  assert.equal(verifyPassword('correct horse batterz', HASH), false);
  assert.equal(verifyPassword('', HASH), false);
  assert.equal(verifyPassword('correct horse battery', 'not a hash'), false);
  assert.notEqual(hashPassword('same password!'), hashPassword('same password!'), 'salted');
});

test('a new password needs 12 characters, typed the same twice', () => {
  assert.match(checkNewPassword('short', 'short'), /12 characters/);
  assert.match(checkNewPassword('long enough pw', 'long enough pX'), /didn.t match/);
  assert.equal(checkNewPassword('long enough pw', 'long enough pw'), null);
});

test('a token we signed is accepted, with a 30-day expiry', () => {
  const now = Date.now();
  const claims = verifyToken(signToken({ secret: SECRET, passwordHash: HASH, now }), { secret: SECRET, passwordHash: HASH, now });
  assert.ok(claims);
  assert.equal(claims.exp - claims.iat, 30 * 86_400);
});

test('tokens that try to get in are refused', () => {
  const now = Date.now();
  const good = signToken({ secret: SECRET, passwordHash: HASH, now });
  const opts = { secret: SECRET, passwordHash: HASH, now };
  const [h, p, s] = good.split('.');
  const flip = (c) => (c === 'A' ? 'B' : 'A');
  const cases = {
    'tampered signature': `${h}.${p}.${flip(s[0])}${s.slice(1)}`,
    'tampered claims': `${h}.${b64({ ...claimsFor(HASH, now), exp: claimsFor(HASH, now).exp + 9999 })}.${s}`,
    'alg none': `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`,
    'alg HS512': forge({ alg: 'HS512', typ: 'JWT' }, claimsFor(HASH, now)),
    'wrong secret': forge({ alg: 'HS256', typ: 'JWT' }, claimsFor(HASH, now), 'x'.repeat(40)),
    'expired': signToken({ secret: SECRET, passwordHash: HASH, now: now - 31 * DAY }),
    'before a password change': signToken({ secret: SECRET, passwordHash: hashPassword('an older password'), now }),
    'two parts': `${h}.${p}`,
    'four parts': `${good}.x`,
    'garbage': 'not-a-token',
    'empty': '',
    'not base64 json': 'e30.e30.e30',
  };
  for (const [name, token] of Object.entries(cases)) assert.equal(verifyToken(token, opts), null, name);
  assert.equal(verifyToken(undefined, opts), null, 'no cookie');
});

test('the session cookie is HttpOnly, Secure, SameSite=Strict, 30 days', () => {
  assert.equal(sessionCookie('abc'), 'session=abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000');
  assert.equal(clearedCookie(), 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  assert.equal(readCookie('a=1; session=xyz; b=2', 'session'), 'xyz');
  assert.equal(readCookie(undefined, 'session'), null);
  assert.equal(readCookie('sessionx=1', 'session'), null);
});

test('five wrong guesses from one address wait 15 minutes; other addresses do not', () => {
  const clock = { t: 0 };
  const limiter = createLimiter({ now: () => clock.t });
  for (let i = 0; i < 5; i += 1) { assert.equal(limiter.blocked('1.1.1.1'), 0); limiter.fail('1.1.1.1'); }
  assert.ok(limiter.blocked('1.1.1.1') > 14 * 60_000);
  assert.equal(limiter.blocked('2.2.2.2'), 0);
  assert.equal(tooManyMessage(12 * 60_000 - 1), 'Too many attempts — try again in 12 minutes.');
  clock.t = 15 * 60_000 + 1;
  assert.equal(limiter.blocked('1.1.1.1'), 0);
});

test('a successful login clears that address’s count', () => {
  const limiter = createLimiter({ now: () => 0 });
  for (let i = 0; i < 4; i += 1) limiter.fail('1.1.1.1');
  limiter.succeed('1.1.1.1');
  limiter.fail('1.1.1.1');
  assert.equal(limiter.blocked('1.1.1.1'), 0);
});

test('behind the proxy, the address is the last X-Forwarded-For entry; earlier ones are forgeable', () => {
  assert.equal(clientAddress({ socketAddress: '10.0.0.5', forwardedFor: '6.6.6.6, 203.0.113.9', trustProxy: true }), '203.0.113.9');
  assert.equal(clientAddress({ socketAddress: '10.0.0.5', forwardedFor: '203.0.113.9', trustProxy: true }), '203.0.113.9');
  assert.equal(clientAddress({ socketAddress: '10.0.0.5', forwardedFor: undefined, trustProxy: true }), '10.0.0.5');
  assert.equal(clientAddress({ socketAddress: '10.0.0.5', forwardedFor: '203.0.113.9', trustProxy: false }), '10.0.0.5');
});

test('login is on with both settings; half-set or weak settings are problems', () => {
  assert.deepEqual(authConfig({}).on, false);
  assert.deepEqual(authConfig({}).problems, []);
  const both = authConfig({ JWT_SECRET: SECRET, LOGIN_PASSWORD_HASH: HASH });
  assert.equal(both.on, true);
  assert.deepEqual(both.problems, []);
  assert.match(authConfig({ JWT_SECRET: SECRET }).problems.join(), /LOGIN_PASSWORD_HASH/);
  assert.match(authConfig({ LOGIN_PASSWORD_HASH: HASH }).problems.join(), /JWT_SECRET/);
  assert.match(authConfig({ JWT_SECRET: 'short', LOGIN_PASSWORD_HASH: HASH }).problems.join(), /32 characters/);
  assert.match(authConfig({ JWT_SECRET: SECRET, LOGIN_PASSWORD_HASH: 'hunter2' }).problems.join(), /hash-password/);
});

test('a public server refuses to start without login, or without ratings', () => {
  const ok = { ok: true };
  const login = { JWT_SECRET: SECRET, LOGIN_PASSWORD_HASH: HASH };
  assert.deepEqual(startupProblems({ env: {}, host: '127.0.0.1', selections: ok }), []);
  assert.deepEqual(startupProblems({ env: {}, host: '127.0.0.1', selections: { ok: false, reason: 'old Node' } }), []);
  assert.match(startupProblems({ env: {}, host: '0.0.0.0', selections: ok }).join(), /Login is required/);
  assert.deepEqual(startupProblems({ env: login, host: '0.0.0.0', selections: ok }), []);
  assert.match(startupProblems({ env: login, host: '0.0.0.0', selections: { ok: false, reason: 'old Node' } }).join(), /old Node/);
  assert.match(startupProblems({ env: { SYNC_KEY: 'short' }, host: '127.0.0.1', selections: ok }).join(), /SYNC_KEY/);
  assert.match(startupProblems({ env: { JWT_SECRET: SECRET }, host: '127.0.0.1', selections: ok }).join(), /LOGIN_PASSWORD_HASH/);
});

test('only the login page, its files, health and the sync routes are open', () => {
  for (const [m, p] of [['GET', '/login'], ['GET', '/login.js'], ['GET', '/favicon-light-mode.png'],
    ['GET', '/favicon-dark-mode.png'], ['GET', '/healthz'], ['POST', '/api/login'], ['POST', '/api/logout'],
    ['PUT', '/api/sync/sailings'], ['GET', '/api/sync/selections']]) {
    assert.ok(isOpenPath(m, p), `${m} ${p}`);
  }
  for (const [m, p] of [['GET', '/'], ['GET', '/index.html'], ['GET', '/index.js'], ['GET', '/mine'],
    ['GET', '/search.js'], ['GET', '/session.js'], ['GET', '/api/dataset'], ['POST', '/api/search'],
    ['GET', '/api/selections'], ['PUT', '/api/selections/rating'], ['GET', '/api/flights'], ['GET', '/api/status'],
    ['GET', '/api/refresh'], ['GET', '/api/login'], ['GET', '/login/../index.html'], ['GET', '/api/syncx']]) {
    assert.equal(isOpenPath(m, p), false, `${m} ${p}`);
  }
});
```

Append to `test/guard.test.js`:

```js
test('a route may allow a bigger body than the 64 KB default', () => {
  const headers = { host, 'content-type': 'application/json', 'content-length': String(MAX_BODY + 1) };
  assert.equal(checkRequest({ method: 'PUT', headers }).status, 413);
  assert.equal(checkRequest({ method: 'PUT', headers, maxBody: 20 * 1024 * 1024 }), null);
});

test('readRaw returns the bytes, and refuses past its limit', async () => {
  assert.deepEqual(await readRaw(Readable.from([Buffer.from([1, 2]), Buffer.from([3])]), 10), Buffer.from([1, 2, 3]));
  await assert.rejects(readRaw(Readable.from([Buffer.alloc(11)]), 10), (err) => err.status === 413);
});
```

(add `readRaw` to the import from `../guard.js`).

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/auth.test.js test/guard.test.js`
Expected: FAIL — `Cannot find module '../auth.js'`; `readRaw` is not exported.

- [ ] **Step 3: `guard.js`** — give `checkRequest` a `maxBody` parameter and add `readRaw`:

```js
/** null if allowed, else { status, error }. `maxBody` is for the few routes that take more. */
export function checkRequest({ method, headers, maxBody = MAX_BODY }) {
```

and in it replace the size check with:

```js
  if (Number(headers['content-length']) > maxBody) {
    return { status: 413, error: `Too large — the limit is ${sizeText(maxBody)}.` };
  }
```

Replace `readBody` with:

```js
const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`);

/** The request body as bytes, refusing more than `maxBody` whatever was declared. */
export async function readRaw(req, maxBody = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) {
      const err = new Error(`Too large — the limit is ${sizeText(maxBody)}.`);
      err.status = 413;
      throw err;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** The request body as text, refusing more than `maxBody` bytes whatever was declared. */
export async function readBody(req, maxBody = MAX_BODY) {
  return (await readRaw(req, maxBody)).toString('utf8');
}
```

Existing guard tests expecting `64 KB` in the message still pass (`sizeText(65536)` is `64 KB`).

- [ ] **Step 4: Write `auth.js`**

```js
/**
 * The login: one user (Peter), a password hash in a setting, an HS256 JWT in a cookie.
 * MyFinancesWeb's design trimmed to one user and no dependencies — node:crypto signs and
 * hashes. Spec: docs/superpowers/specs/2026-10-16-deployment-design.md, part 4.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD = 12;
export const MIN_SECRET = 32;
const SESSION_SECONDS = 30 * 86_400;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const HASH_FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]{16,})\$([\w-]{40,})$/;

export function hashPassword(password, salt = randomBytes(16)) {
  const { N, r, p, keylen, maxmem } = SCRYPT;
  const hash = scryptSync(password, salt, keylen, { N, r, p, maxmem });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export const isPasswordHash = (stored) => HASH_FORMAT.test(stored ?? '');

export function verifyPassword(password, stored) {
  const m = HASH_FORMAT.exec(stored ?? '');
  if (!m || typeof password !== 'string') return false;
  const [, N, r, p, salt, hash] = m;
  const expected = Buffer.from(hash, 'base64url');
  const given = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(given, expected);
}

export function checkNewPassword(a, b) {
  if (typeof a !== 'string' || a.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (a !== b) return 'The two passwords didn’t match.';
  return null;
}

const b64json = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const HEADER = b64json({ alg: 'HS256', typ: 'JWT' });
/** Ties a session to this password: a new password ends every session made with the old one. */
const fingerprint = (passwordHash) => createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

export function signToken({ secret, passwordHash, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const body = `${HEADER}.${b64json({ iat, exp: iat + SESSION_SECONDS, pwf: fingerprint(passwordHash) })}`;
  return `${body}.${sign(secret, body)}`;
}

const parseJson = (part) => {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
};

/** The claims, or null. Every check must pass; there is no partial trust. */
export function verifyToken(token, { secret, passwordHash, now = Date.now() }) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const header = parseJson(h);
  if (!header || header.alg !== 'HS256') return null; // only HS256: never 'none', never another key type
  const expected = Buffer.from(sign(secret, `${h}.${p}`));
  const given = Buffer.from(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = parseJson(p);
  if (!claims || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(now / 1000)) return null;
  if (claims.pwf !== fingerprint(passwordHash)) return null;
  return claims;
}

const COOKIE = 'HttpOnly; Secure; SameSite=Strict; Path=/';
export const sessionCookie = (token) => `session=${token}; ${COOKIE}; Max-Age=${SESSION_SECONDS}`;
export const clearedCookie = () => `session=; ${COOKIE}; Max-Age=0`;

export function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Wrong passwords and wrong sync keys, per address. In memory: a restart resets it. */
export function createLimiter({ max = 5, windowMs = 15 * 60_000, now = Date.now } = {}) {
  const seen = new Map(); // address → { count, first }
  const fresh = (addr) => {
    const entry = seen.get(addr);
    if (entry && now() - entry.first > windowMs) { seen.delete(addr); return null; }
    return entry ?? null;
  };
  return {
    /** Milliseconds to wait, or 0. */
    blocked(addr) {
      const entry = fresh(addr);
      return entry && entry.count >= max ? entry.first + windowMs - now() : 0;
    },
    fail(addr) {
      for (const [a, e] of seen) if (now() - e.first > windowMs) seen.delete(a);
      const entry = fresh(addr);
      if (entry) entry.count += 1;
      else seen.set(addr, { count: 1, first: now() });
    },
    succeed(addr) { seen.delete(addr); },
  };
}

export const tooManyMessage = (ms) => `Too many attempts — try again in ${Math.max(1, Math.ceil(ms / 60_000))} minutes.`;

/**
 * Behind Coolify's proxy every request comes from the proxy. The proxy appends the address
 * it saw to X-Forwarded-For; anything before that came from the client and can be forged.
 */
export function clientAddress({ socketAddress, forwardedFor, trustProxy }) {
  if (trustProxy && forwardedFor) {
    const last = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return socketAddress ?? 'unknown';
}

export function authConfig(env) {
  const secret = env.JWT_SECRET ?? '';
  const passwordHash = env.LOGIN_PASSWORD_HASH ?? '';
  const problems = [];
  if (secret || passwordHash) {
    if (!secret) problems.push('JWT_SECRET is missing (npm run make-key makes one).');
    else if (secret.length < MIN_SECRET) problems.push(`JWT_SECRET must be at least ${MIN_SECRET} characters (npm run make-key).`);
    if (!passwordHash) problems.push('LOGIN_PASSWORD_HASH is missing (npm run hash-password makes one).');
    else if (!isPasswordHash(passwordHash)) problems.push('LOGIN_PASSWORD_HASH is not a hash from npm run hash-password.');
  }
  return { on: Boolean(secret && passwordHash) && problems.length === 0, secret, passwordHash, problems };
}

export const isLocalHost = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);

/** Why the server must not start, or []. */
export function startupProblems({ env, host, selections }) {
  const auth = authConfig(env);
  const problems = [...auth.problems];
  if (!isLocalHost(host)) {
    if (!auth.on && auth.problems.length === 0) {
      problems.push(`Login is required when HOST is ${host}: set JWT_SECRET and LOGIN_PASSWORD_HASH.`);
    }
    if (!selections?.ok) problems.push(`Ratings could not open: ${selections?.reason ?? 'unknown'}`);
  }
  if (env.SYNC_KEY !== undefined && env.SYNC_KEY.length < MIN_SECRET) {
    problems.push(`SYNC_KEY must be at least ${MIN_SECRET} characters (npm run make-key).`);
  }
  return problems;
}

const OPEN = new Set(['GET /login', 'GET /login.js', 'GET /favicon-light-mode.png', 'GET /favicon-dark-mode.png',
  'GET /healthz', 'POST /api/login', 'POST /api/logout']);

/** Reachable without a session. The sync routes check their own key. */
export function isOpenPath(method, path) {
  return OPEN.has(`${method} ${path}`) || path.startsWith('/api/sync/');
}
```

- [ ] **Step 5: Run the auth and guard tests**

Run: `node --test test/auth.test.js test/guard.test.js`
Expected: PASS.

- [ ] **Step 6: The tools** — `tools/hash-password.js`:

```js
// npm run hash-password — asks for a password twice (not shown) and prints the hash for
// LOGIN_PASSWORD_HASH. The password itself is never stored or printed.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { checkNewPassword, hashPassword } from '../auth.js';

const silent = new Writable({ write(_chunk, _enc, done) { done(); } });
async function ask(prompt) {
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  const answer = await rl.question('');
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const a = await ask('New password: ');
const b = await ask('Again: ');
const problem = checkNewPassword(a, b);
if (problem) {
  console.error(problem);
  process.exit(1);
}
console.log(`\nLOGIN_PASSWORD_HASH=${hashPassword(a)}`);
console.log('\nPaste that line into Coolify (Environment Variables). A new hash logs out every device.');
```

`tools/make-key.js`:

```js
// npm run make-key — a random 43-character key, for JWT_SECRET or SYNC_KEY.
import { randomBytes } from 'node:crypto';
console.log(randomBytes(32).toString('base64url'));
```

`package.json` scripts — add:

```json
    "hash-password": "node tools/hash-password.js",
    "make-key": "node tools/make-key.js"
```

Run: `npm run make-key | awk '{ print length($0) }'`
Expected: `43`.

- [ ] **Step 7: The pages** — `public/login.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in · Cruise search</title>
<link rel="icon" type="image/png" href="/favicon-light-mode.png" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/png" href="/favicon-dark-mode.png" media="(prefers-color-scheme: dark)">
<style>
  :root { --ink: #1c2430; --muted: #6b7580; --line: #d9dee4; --accent: #0b6bcb; --bad: #b3261e; --bg: #f6f7f9; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e6e9ee; --muted: #9aa4af; --line: #2c3440; --accent: #5aa9ff; --bad: #ff8a80; --bg: #12161c; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.4 system-ui, sans-serif; color: var(--ink); background: var(--bg); }
  form { width: min(340px, calc(100vw - 32px)); display: grid; gap: 12px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  input { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  button { font: inherit; font-weight: 600; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
  .error { color: var(--bad); min-height: 1.4em; font-size: 14px; }
  .hidden-user { position: absolute; left: -10000px; }
</style>
</head>
<body>
<form id="login">
  <h1>Cruise search</h1>
  <input class="hidden-user" type="text" name="username" value="peter" autocomplete="username" tabindex="-1" aria-hidden="true">
  <input id="password" type="password" name="password" autocomplete="current-password" placeholder="Password" required autofocus>
  <button type="submit">Log in</button>
  <div id="error" class="error" role="alert"></div>
</form>
<script type="module" src="/login.js"></script>
</body>
</html>
```

`public/login.js`:

```js
const form = document.querySelector('#login');
const error = document.querySelector('#error');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.querySelector('#password').value }),
  });
  if (res.ok) { location.assign('/'); return; }
  const data = await res.json().catch(() => ({}));
  error.textContent = data.error ?? `Login failed (${res.status}).`;
});
```

`public/session.js`:

```js
// Shared by the search page and /mine. A 401 means the session ended: go and log in.
// Also shows "Log out" (when the login is on) and the Mac's mirror note (Task 4).
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401) location.assign('/login');
  return res;
};

const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

async function showStatus() {
  const res = await nativeFetch('/api/status');
  if (!res.ok) return;
  const status = await res.json();
  const account = document.querySelector('#account');
  if (status.login && account) {
    const out = document.createElement('a');
    out.href = '/login';
    out.textContent = 'Log out';
    out.addEventListener('click', async (e) => {
      e.preventDefault();
      await nativeFetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      location.assign('/login');
    });
    account.append(out);
  }
  const note = document.querySelector('#mirror-note');
  if (status.mirror && note) {
    note.textContent = status.ratingsCopiedAt
      ? `Ratings copied from the server at ${when(status.ratingsCopiedAt)} — changes here aren't kept`
      : 'Ratings not yet copied from the server — changes here aren\'t kept';
    note.hidden = false;
  }
}
showStatus();
```

In `public/index.js` and `public/mine.js`, add as the very first line: `import '/session.js';`

In `public/index.html`, inside `<header><div class="wrap">`, after `<h1>Cruise search</h1>`:

```html
    <div id="account" class="account"></div>
    <div id="mirror-note" class="sub mirror-note" hidden></div>
```

and in its `<style>`:

```css
  .account { position: absolute; top: 14px; right: 16px; font-size: 14px; }
  .account a { color: var(--accent); text-decoration: none; }
  header .wrap { position: relative; }
```

In `public/mine.html`, after `<h1>My cruises</h1>`: the same two `div`s, and the same CSS with `.wrap { position: relative; }`.

- [ ] **Step 8: Wire `server.js`** — imports:

```js
import {
  authConfig, startupProblems, isOpenPath, verifyToken, signToken, verifyPassword, sessionCookie,
  clearedCookie, readCookie, createLimiter, tooManyMessage, clientAddress, isLocalHost,
} from './auth.js';
```

After `const HOST = …`:

```js
const auth = authConfig(process.env);
const deployed = !isLocalHost(HOST);
const trustProxy = process.env.TRUST_PROXY === '1';
// Wrong passwords and wrong sync keys share one count per address.
const limiter = createLimiter();
const addressOf = (req) => clientAddress({
  socketAddress: req.socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'], trustProxy,
});
const signedIn = (req) => Boolean(verifyToken(readCookie(req.headers.cookie, 'session'), auth));
```

The header loop from Task 2 becomes `securityHeaders({ deployed, host: req.headers.host, login: auth.on })`. Right after it, the gate and the login routes:

```js
    const path = req.url.split('?')[0];

    if (auth.on && !isOpenPath(req.method, path) && !signedIn(req)) {
      if (path.startsWith('/api/')) return json(res, 401, { error: 'Log in first.' });
      res.writeHead(302, { location: '/login' });
      return res.end();
    }

    if (req.method === 'GET' && path === '/login') {
      if (!auth.on || signedIn(req)) {
        res.writeHead(302, { location: '/' });
        return res.end();
      }
      const html = await readFile(join(PUBLIC_DIR, 'login.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }
```

Inside the existing `/api/` section, after the `checkRequest` refusal, add:

```js
    if (req.method === 'POST' && path === '/api/login') {
      if (!auth.on) return json(res, 404, { error: 'The login is off on this copy.' });
      const address = addressOf(req);
      const wait = limiter.blocked(address);
      if (wait) return json(res, 429, { error: tooManyMessage(wait) });
      let password;
      try { ({ password } = JSON.parse(await readBody(req) || '{}')); } catch { password = null; }
      if (typeof password !== 'string' || !verifyPassword(password, auth.passwordHash)) {
        limiter.fail(address);
        return json(res, 401, { error: 'Wrong password' });
      }
      limiter.succeed(address);
      res.writeHead(204, { 'set-cookie': sessionCookie(signToken(auth)) });
      return res.end();
    }

    if (req.method === 'POST' && path === '/api/logout') {
      res.writeHead(204, { 'set-cookie': clearedCookie() });
      return res.end();
    }

    if (req.method === 'GET' && path === '/api/status') {
      return json(res, 200, { login: auth.on, mirror: false, ratingsCopiedAt: null });
    }
```

The login 401 must not send the login page to `/login` in a loop: `session.js` is not loaded by `login.html`, and `login.js` reads the 401 body itself. Correct.

Before `server.listen(…)`, after `const selections = await openSelections(SELECTIONS_FILE);`:

```js
// A server that others can reach must not start half-protected: no login, or ratings that
// silently don't save. On this Mac (127.0.0.1) the app still runs without ratings and says why.
const problems = startupProblems({ env: process.env, host: HOST, selections });
if (problems.length > 0) {
  console.error('Not starting:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
```

and in the `listen` callback add `console.log(auth.on ? 'Login: on' : 'Login: off (this Mac only)');`.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 10: Check the login against a scratch copy (plain HTTP — the cookie is `Secure`, so curl, not a browser)**

```bash
SCRATCH=<session scratchpad>; D="$SCRATCH/deploy-check"
export JWT_SECRET=$(npm run -s make-key)
export LOGIN_PASSWORD_HASH=$(node -e "import('./auth.js').then(a => console.log(a.hashPassword('check password 123')))")
PORT=3031 SELECTIONS_FILE="$D/selections.db" node server.js > "$D/server.log" 2>&1 &
sleep 1
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:3031/
curl -s -w ' %{http_code}\n' http://127.0.0.1:3031/api/dataset
curl -s -w ' %{http_code}\n' -X POST -H 'content-type: application/json' -d '{"password":"nope"}' http://127.0.0.1:3031/api/login
curl -s -D - -o /dev/null -X POST -H 'content-type: application/json' -d '{"password":"check password 123"}' http://127.0.0.1:3031/api/login | grep -i '^set-cookie' | sed 's/session=[^;]*/session=<token>/'
TOKEN=$(curl -s -D - -o /dev/null -X POST -H 'content-type: application/json' -d '{"password":"check password 123"}' http://127.0.0.1:3031/api/login | sed -n 's/^set-cookie: session=\([^;]*\).*/\1/Ip')
curl -s -o /dev/null -w '%{http_code}\n' -H "cookie: session=$TOKEN" http://127.0.0.1:3031/api/dataset
for i in 1 2 3 4 5; do curl -s -o /dev/null -X POST -H 'content-type: application/json' -d '{"password":"nope"}' http://127.0.0.1:3031/api/login; done
curl -s -w ' %{http_code}\n' -X POST -H 'content-type: application/json' -d '{"password":"check password 123"}' http://127.0.0.1:3031/api/login
curl -s -D - -o /dev/null -H "cookie: session=$TOKEN" http://127.0.0.1:3031/ | grep -iE '^(cache-control|content-security-policy|strict-transport)' | cut -c1-60
HOST=0.0.0.0 PORT=3032 JWT_SECRET= LOGIN_PASSWORD_HASH= SELECTIONS_FILE="$D/s2.db" node server.js 2>&1 | head -3
```

Expected, in order: `302 http://127.0.0.1:3031/login`; `{"error":"Log in first."} 401`; `{"error":"Wrong password"} 401`; `set-cookie: session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`; `200`; after five more wrong guesses the right password gets `{"error":"Too many attempts — try again in 15 minutes."} 429`; `cache-control: no-store` and the CSP present, no HSTS (localhost); the last command prints `Not starting:` and `Login is required when HOST is 0.0.0.0…`. Stop the copy afterwards (`lsof -ti :3031 | xargs kill`). Unset the two exports.

- [ ] **Step 11: Commit**

```bash
git add auth.js guard.js server.js package.json tools/hash-password.js tools/make-key.js public/login.html public/login.js public/session.js public/index.html public/index.js public/mine.html public/mine.js test/auth.test.js test/guard.test.js
git commit -m "Add a one-user login: scrypt password hash, HS256 session cookie, guessing limit, refuse to start unprotected"
```

---

### Task 4: Sync — upload, ratings pull and push, the mirror note

**Files:**
- Create: `paths.js`, `sync-server.js`, `sync.js`, `tools/sync.js`
- Modify: `selections.js` (`meta` table, `checkRows`, `replaceAll`, `copiedAt`), `server.js` (`DATA_DIR`, sync routes, status, dataset message), `scrape.js` (`DATA_DIR`), `package.json` (scripts)
- Test: `test/sync.test.js`, `test/selections.test.js`

**Interfaces:**
- Consumes: `createLimiter`, `tooManyMessage` (Task 3); `readRaw`, `checkRequest({ maxBody })` (Task 3).
- Produces:
  - `paths.js`: `dataDir(env = process.env) → string` (absolute; `DATA_DIR` or `<app>/data`)
  - `selections.js`: `checkRows(rows) → string|null`; store `replaceAll(rows, { copiedAt? }) → number`, `copiedAt() → string|null`
  - `sync-server.js`: `LIMITS = { maxCompressed: 20 MB, maxJson: 50 MB }`; `keyMatches(authorization, key) → boolean`; `checkSailings(data, currentCount, force) → string|null`; `storeSailings(dir, text) → Promise<void>`; `handleSync({ method, path, query: URLSearchParams, headers, readBody: () => Promise<Buffer> }, { key, dataDir, store, address, limiter, limits? }) → Promise<{status, body}>`
  - `sync.js`: `syncConfig(env) → { url, key }|null` (throws on a plain-HTTP non-local URL); `uploadSailings({ config, dataFile, force?, fetchImpl? }) → Promise<{stored, was}>`; `pullRatings({ config, store, fetchImpl?, now? }) → Promise<{copied}>`; `pushRatings({ config, store, force?, fetchImpl? }) → Promise<{stored}>`
  - `GET /api/status` gains `mirror: Boolean(syncConfig)`, `ratingsCopiedAt: store.copiedAt()`.

- [ ] **Step 1: Write the failing tests** — append to `test/selections.test.js` (add `checkRows` to its import):

```js
const row = (over = {}) => ({
  sailingId: 'cunard:M626C', rating: 4, views: 2, firstViewed: '2026-10-01T10:00:00Z',
  lastViewed: '2026-10-02T10:00:00Z', ratedAt: '2026-10-02T10:01:00Z', snapshot: snapshotOf(sailing()), ...over,
});

test('checkRows names the first bad row', () => {
  assert.equal(checkRows([row()]), null);
  assert.match(checkRows('x'), /selections/);
  assert.match(checkRows([row({ sailingId: '' })]), /sailingId/);
  assert.match(checkRows([row(), row()]), /twice/);
  assert.match(checkRows([row({ rating: 6 })]), /1–5/);
  assert.match(checkRows([row({ views: -1 })]), /views/);
  assert.match(checkRows([row({ snapshot: null })]), /snapshot/);
});

dbTest('replaceAll swaps every row, keeping every column, and records when', async () => {
  const store = await openSelections(tmp());
  store.recordView(sailing({ id: 'old:1' }), '2026-09-01T00:00:00Z');
  const rows = [row(), row({ sailingId: 'viking:2', rating: null, views: 1, ratedAt: null })];
  assert.equal(store.replaceAll(rows, { copiedAt: '2026-10-16T14:05:00Z' }), 2);
  assert.deepEqual(store.all(), rows);
  assert.equal(store.copiedAt(), '2026-10-16T14:05:00Z');
  store.close();
});

dbTest('replaceAll is all or nothing: a row that fails mid-way leaves the old rows', async () => {
  const store = await openSelections(tmp());
  store.recordView(sailing(), '2026-09-01T00:00:00Z');
  const before = store.all();
  // passes checkRows, but SQLite cannot bind an object — fails after the first insert
  assert.throws(() => store.replaceAll([row({ sailingId: 'a:1' }), row({ sailingId: 'b:2', firstViewed: {} })]));
  assert.deepEqual(store.all(), before);
  assert.equal(store.copiedAt(), null);
  store.close();
});

dbTest('replaceAll without copiedAt (a push to the server) records no copy time', async () => {
  const store = await openSelections(tmp());
  store.replaceAll([row()]);
  assert.equal(store.copiedAt(), null);
  store.close();
});
```

`test/sync.test.js`:

```js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { openSelections, snapshotOf, nodeSupportsSqlite } from '../selections.js';
import { createLimiter } from '../auth.js';
import { handleSync, keyMatches, checkSailings, storeSailings, LIMITS } from '../sync-server.js';
import { syncConfig, uploadSailings, pullRatings, pushRatings } from '../sync.js';

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const scratchDir = () => { const dir = mkdtempSync(join(tmpdir(), 'sync-')); scratch.push(dir); return dir; };
const dbTest = nodeSupportsSqlite() ? test : (name, fn) => test(name, { skip: 'needs Node 24.15+' }, fn);

const KEY = 'k'.repeat(40);
const sailing = (i) => ({ id: `viking:${i}`, line: 'Viking', departureDate: '2027-01-02', ship: 'Viking Mars' });
const dataset = (n) => ({ scrapedAt: '2026-10-16T00:00:00Z', sailings: Array.from({ length: n }, (_, i) => sailing(i)), ships: {} });
const gz = (o) => gzipSync(Buffer.from(JSON.stringify(o)));

/** A request as server.js hands it to handleSync. */
const req = ({ method = 'PUT', path = '/api/sync/sailings', query = '', key = KEY, body = Buffer.alloc(0), gzip = true } = {}) => ({
  method, path, query: new URLSearchParams(query),
  headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(gzip ? { 'content-encoding': 'gzip' } : {}) },
  readBody: async () => body,
});
async function context({ current = null, store = null } = {}) {
  const dir = scratchDir();
  if (current) writeFileSync(join(dir, 'sailings.json'), JSON.stringify(current));
  return { key: KEY, dataDir: dir, store, address: '203.0.113.9', limiter: createLimiter() };
}

test('the key must match, compared whatever its length', () => {
  assert.ok(keyMatches(`Bearer ${KEY}`, KEY));
  assert.equal(keyMatches(`Bearer ${KEY}x`, KEY), false);
  assert.equal(keyMatches('Bearer ', KEY), false);
  assert.equal(keyMatches(KEY, KEY), false);
  assert.equal(keyMatches(undefined, KEY), false);
  assert.equal(keyMatches(`Bearer ${KEY}`, ''), false);
});

test('a wrong or missing key is refused, and counts toward the guessing limit', async () => {
  const ctx = await context();
  assert.equal((await handleSync(req({ key: 'wrong' }), ctx)).status, 401);
  assert.equal((await handleSync(req({ key: null }), ctx)).status, 401);
  for (let i = 0; i < 3; i += 1) await handleSync(req({ key: 'wrong' }), ctx);
  const out = await handleSync(req({ body: gz(dataset(5)) }), ctx);
  assert.equal(out.status, 429, 'blocked even with the right key after 5 wrong ones');
});

test('a server with no SYNC_KEY has no sync routes', async () => {
  const ctx = { ...(await context()), key: '' };
  assert.equal((await handleSync(req({ body: gz(dataset(5)) }), ctx)).status, 404);
});

test('an upload replaces the data, keeps the previous file, and says how many', async () => {
  const ctx = await context({ current: dataset(10) });
  const out = await handleSync(req({ body: gz(dataset(12)) }), ctx);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { stored: 12, was: 10 });
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.json'))).sailings.length, 12);
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.previous.json'))).sailings.length, 10);
});

test('the first upload, to an empty server, is accepted', async () => {
  const ctx = await context();
  assert.deepEqual((await handleSync(req({ body: gz(dataset(3)) }), ctx)).body, { stored: 3, was: 0 });
});

test('an upload with fewer than half the sailings is refused unless forced', async () => {
  const ctx = await context({ current: dataset(10) });
  const out = await handleSync(req({ body: gz(dataset(4)) }), ctx);
  assert.equal(out.status, 409);
  assert.match(out.body.error, /fewer than half/);
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.json'))).sailings.length, 10, 'unchanged');
  assert.equal((await handleSync(req({ body: gz(dataset(4)), query: 'force=1' }), ctx)).status, 200);
});

test('broken uploads are refused and change nothing', async () => {
  const ctx = await context({ current: dataset(10) });
  const cases = {
    'not gzip': req({ body: Buffer.from('{"sailings":[]}') }),
    'not JSON': req({ body: gzipSync(Buffer.from('{oops')) }),
    'no sailings': req({ body: gz({ sailings: [] }) }),
    'missing id': req({ body: gz({ sailings: [{ line: 'Viking', departureDate: '2027-01-02' }] }) }),
    'missing date': req({ body: gz({ sailings: Array.from({ length: 10 }, (_, i) => ({ ...sailing(i), departureDate: undefined })) }) }),
  };
  for (const [name, r] of Object.entries(cases)) {
    const out = await handleSync(r, ctx);
    assert.equal(out.status, 400, name);
    assert.ok(out.body.error, name);
  }
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'sailings.json'))).sailings.length, 10);
});

test('a zip bomb is stopped at the unpacked limit', async () => {
  const ctx = { ...(await context()), limits: { ...LIMITS, maxJson: 1024 * 1024 } };
  const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x20)); // ~4 KB packed, 4 MB unpacked
  const out = await handleSync(req({ body: bomb }), ctx);
  assert.equal(out.status, 413);
  assert.match(out.body.error, /unpacked/);
});

test('the current file is never absent: copied to .previous, then the new one renamed over it', async () => {
  const dir = scratchDir();
  writeFileSync(join(dir, 'sailings.json'), '{"sailings":[1]}');
  await storeSailings(dir, '{"sailings":[2]}');
  assert.equal(readFileSync(join(dir, 'sailings.json'), 'utf8'), '{"sailings":[2]}');
  assert.equal(readFileSync(join(dir, 'sailings.previous.json'), 'utf8'), '{"sailings":[1]}');
  assert.equal(existsSync(join(dir, 'sailings.json.tmp')), false);
});

test('checkSailings explains each refusal', () => {
  assert.equal(checkSailings(dataset(6), 10, false), null);
  assert.match(checkSailings(dataset(4), 10, false), /fewer than half the 10/);
  assert.equal(checkSailings(dataset(4), 10, true), null);
  assert.match(checkSailings({}, 0, false), /No sailings/);
});

dbTest('ratings come down with every column, and a push needs force when the server has rows', async () => {
  const store = await openSelections(join(scratchDir(), 'server.db'));
  store.recordView({ id: 'viking:1', line: 'Viking', departureDate: '2027-01-02' }, '2026-10-01T00:00:00Z');
  const ctx = await context({ store });
  const out = await handleSync(req({ method: 'GET', path: '/api/sync/selections', gzip: false }), ctx);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.selections, store.all());

  const rows = [{ sailingId: 'cunard:1', rating: 5, views: 0, firstViewed: null, lastViewed: null, ratedAt: '2026-10-16T00:00:00Z', snapshot: snapshotOf({ id: 'cunard:1' }) }];
  const refused = await handleSync(req({ path: '/api/sync/selections', body: gz({ selections: rows }) }), ctx);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already has 1/);
  const forced = await handleSync(req({ path: '/api/sync/selections', query: 'force=1', body: gz({ selections: rows }) }), ctx);
  assert.deepEqual(forced.body, { stored: 1 });
  assert.deepEqual(store.all(), rows);
  store.close();
});

dbTest('a 500-row push is accepted (bigger than the 64 KB other routes allow)', async () => {
  const store = await openSelections(join(scratchDir(), 'server.db'));
  const ctx = await context({ store });
  const rows = Array.from({ length: 500 }, (_, i) => ({
    sailingId: `royal:${i}`, rating: 3, views: 1, firstViewed: null, lastViewed: null, ratedAt: null,
    snapshot: snapshotOf({ id: `royal:${i}`, itinerary: 'x'.repeat(200), image: `https://example.com/${'p'.repeat(150)}.jpg` }),
  }));
  assert.ok(JSON.stringify({ selections: rows }).length > 64 * 1024);
  assert.deepEqual((await handleSync(req({ path: '/api/sync/selections', body: gz({ selections: rows }) }), ctx)).body, { stored: 500 });
  store.close();
});

// The client, against handleSync itself — no network.
const fetchVia = (ctx) => async (url, init = {}) => {
  const u = new URL(url);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const out = await handleSync({
    method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, headers,
    readBody: async () => Buffer.from(init.body ?? ''),
  }, ctx);
  return new Response(JSON.stringify(out.body), { status: out.status });
};
const config = { url: 'https://ai-cruises.example', key: KEY };

test('SYNC_URL must be https, except localhost', () => {
  assert.equal(syncConfig({}), null);
  assert.equal(syncConfig({ SYNC_URL: 'https://x.org' }), null, 'no key');
  assert.deepEqual(syncConfig({ SYNC_URL: 'https://x.org/', SYNC_KEY: KEY }), { url: 'https://x.org', key: KEY });
  assert.deepEqual(syncConfig({ SYNC_URL: 'http://localhost:3031', SYNC_KEY: KEY }), { url: 'http://localhost:3031', key: KEY });
  assert.throws(() => syncConfig({ SYNC_URL: 'http://x.org', SYNC_KEY: KEY }), /https/);
});

test('uploadSailings sends the file compressed and reports the server’s answer', async () => {
  const ctx = await context({ current: dataset(10) });
  const file = join(scratchDir(), 'sailings.json');
  writeFileSync(file, JSON.stringify(dataset(11)));
  assert.deepEqual(await uploadSailings({ config, dataFile: file, fetchImpl: fetchVia(ctx) }), { stored: 11, was: 10 });
});

test('the client explains a wrong key, a refusal and an unreachable server', async () => {
  const ctx = await context({ current: dataset(10) });
  const file = join(scratchDir(), 'sailings.json');
  writeFileSync(file, JSON.stringify(dataset(2)));
  await assert.rejects(uploadSailings({ config: { ...config, key: 'wrong' }, dataFile: file, fetchImpl: fetchVia(ctx) }), /SYNC_KEY/);
  await assert.rejects(uploadSailings({ config, dataFile: file, fetchImpl: fetchVia(ctx) }), /fewer than half/);
  const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(uploadSailings({ config, dataFile: file, fetchImpl: down }), /Could not reach https:\/\/ai-cruises\.example \(ECONNREFUSED\)/);
});

dbTest('pullRatings copies the server’s rows and the time; a cut-off answer changes nothing', async () => {
  const server = await openSelections(join(scratchDir(), 'server.db'));
  server.setRating('viking:1', 5, '2026-10-16T00:00:00Z', { id: 'viking:1', line: 'Viking' });
  const ctx = await context({ store: server });
  const mac = await openSelections(join(scratchDir(), 'mac.db'));
  mac.setRating('cunard:9', 2, '2026-10-01T00:00:00Z', { id: 'cunard:9' });

  assert.deepEqual(await pullRatings({ config, store: mac, fetchImpl: fetchVia(ctx), now: () => '2026-10-16T14:05:00Z' }), { copied: 1 });
  assert.deepEqual(mac.all(), server.all());
  assert.equal(mac.copiedAt(), '2026-10-16T14:05:00Z');

  const before = mac.all();
  const cutOff = async () => new Response('{"selections":[{"sailingId":"x"', { status: 200 });
  await assert.rejects(pullRatings({ config, store: mac, fetchImpl: cutOff }), /cut off/);
  assert.deepEqual(mac.all(), before);
  server.close(); mac.close();
});

dbTest('pushRatings moves the Mac’s rows to an empty server, once', async () => {
  const server = await openSelections(join(scratchDir(), 'server.db'));
  const ctx = await context({ store: server });
  const mac = await openSelections(join(scratchDir(), 'mac.db'));
  mac.setRating('cunard:9', 4, '2026-10-01T00:00:00Z', { id: 'cunard:9' });
  assert.deepEqual(await pushRatings({ config, store: mac, fetchImpl: fetchVia(ctx) }), { stored: 1 });
  assert.deepEqual(server.all(), mac.all());
  await assert.rejects(pushRatings({ config, store: mac, fetchImpl: fetchVia(ctx) }), /already has 1/);
  server.close(); mac.close();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/sync.test.js test/selections.test.js`
Expected: FAIL — `Cannot find module '../sync-server.js'`; `checkRows` not exported.

- [ ] **Step 3: `selections.js`** — extend the schema, add `checkRows`, and two store methods.

Replace `const SCHEMA = \`…\`;` with (the `meta` table is new; `db.exec` runs both):

```js
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS selections (
    sailing_id   TEXT PRIMARY KEY,
    rating       INTEGER CHECK (rating BETWEEN 1 AND 5),
    first_viewed TEXT,
    last_viewed  TEXT,
    views        INTEGER NOT NULL DEFAULT 0,
    rated_at     TEXT,
    snapshot     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;
```

After `const isRating = …`:

```js
/** Rows as store.all() returns them, checked before any replace. The first problem, or null. */
export function checkRows(rows) {
  if (!Array.isArray(rows)) return 'Send { "selections": [...] }.';
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r.sailingId !== 'string' || !r.sailingId) return 'A saved cruise has no sailingId.';
    if (seen.has(r.sailingId)) return `${r.sailingId} appears twice.`;
    seen.add(r.sailingId);
    if (r.rating !== null && !isRating(r.rating)) return `${r.sailingId}: a rating is 1–5 or null.`;
    if (!Number.isInteger(r.views) || r.views < 0) return `${r.sailingId}: views must be a whole number, 0 or more.`;
    if (!r.snapshot || typeof r.snapshot !== 'object' || Array.isArray(r.snapshot)) return `${r.sailingId}: no snapshot.`;
  }
  return null;
}
```

In `storeFor`'s `q`, add:

```js
    clear: db.prepare('DELETE FROM selections'),
    insert: db.prepare(`
      INSERT INTO selections (sailing_id, rating, first_viewed, last_viewed, views, rated_at, snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
```

and to `store`, before `close`:

```js
    /**
     * Replaces every row — the Mac copying the server's ratings (with `copiedAt`), or the
     * server receiving the Mac's once. One transaction: a failure leaves the old rows.
     */
    replaceAll(rows, { copiedAt = null } = {}) {
      const problem = checkRows(rows);
      if (problem) throw new RangeError(problem);
      db.exec('BEGIN');
      try {
        q.clear.run();
        for (const r of rows) {
          q.insert.run(r.sailingId, r.rating, r.firstViewed ?? null, r.lastViewed ?? null, r.views,
            r.ratedAt ?? null, JSON.stringify(r.snapshot));
        }
        if (copiedAt) q.setMeta.run('ratings_copied_at', copiedAt);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return rows.length;
    },

    /** When the Mac last copied the server's ratings, or null. */
    copiedAt: () => q.getMeta.get('ratings_copied_at')?.value ?? null,
```

- [ ] **Step 4: `paths.js`**

```js
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where sailings.json lives: DATA_DIR, or the app's data/ folder. A second copy for checks
 * points DATA_DIR at scratch, so neither its server nor its Refresh touches Peter's data.
 */
export function dataDir(env = process.env) {
  return env.DATA_DIR ? resolve(env.DATA_DIR) : fileURLToPath(new URL('./data/', import.meta.url));
}
```

In `scrape.js`: `import { dataDir } from './paths.js';` and `const DATA_DIR = dataDir();` (replacing the `new URL('./data/', …)` line).

- [ ] **Step 5: `sync-server.js`**

```js
/**
 * The server's end of the sync: the Mac uploads sailings.json and copies the ratings, with a
 * shared key (SYNC_KEY), not the login — the Mac's copy has no browser session.
 * Spec: docs/superpowers/specs/2026-10-16-deployment-design.md, part 3.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checkRows } from './selections.js';
import { tooManyMessage } from './auth.js';

export const LIMITS = { maxCompressed: 20 * 1024 * 1024, maxJson: 50 * 1024 * 1024 };

const digest = (s) => createHash('sha256').update(s).digest();

/** Compared as SHA-256 digests, so the comparison takes the same time whatever the length. */
export function keyMatches(authorization, key) {
  if (!key) return false;
  const m = /^Bearer (.+)$/.exec(authorization ?? '');
  return Boolean(m) && timingSafeEqual(digest(m[1]), digest(key));
}

export function checkSailings(data, currentCount, force) {
  const sailings = data?.sailings;
  if (!Array.isArray(sailings) || sailings.length === 0) return 'No sailings in the upload — nothing changed.';
  const bad = sailings.find((s) => !s || typeof s.id !== 'string' || !s.id || typeof s.line !== 'string' || !s.line
    || !/^\d{4}-\d{2}-\d{2}/.test(s.departureDate ?? ''));
  if (bad) return `A sailing is missing its id, line or departure date (${bad?.id ?? 'no id'}) — nothing changed.`;
  if (!force && currentCount > 0 && sailings.length < currentCount / 2) {
    return `Only ${sailings.length} sailings — fewer than half the ${currentCount} the server has. Nothing changed. `
      + 'If that is right, send it again with --force.';
  }
  return null;
}

/** Copy, then rename: sailings.json is never missing, even for a moment. */
export async function storeSailings(dir, text) {
  const target = join(dir, 'sailings.json');
  const temp = `${target}.tmp`;
  await writeFile(temp, text, 'utf8');
  await copyFile(target, join(dir, 'sailings.previous.json')).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await rename(temp, target);
}

async function currentCount(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'sailings.json'), 'utf8')).sailings?.length ?? 0;
  } catch {
    return 0;
  }
}

function decode(body, encoding, limits) {
  if (encoding !== 'gzip') return body;
  try {
    return gunzipSync(body, { maxOutputLength: limits.maxJson });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
      throw Object.assign(new Error(`Too large — over ${limits.maxJson / 1024 / 1024} MB unpacked.`), { status: 413 });
    }
    throw Object.assign(new Error('That upload is not valid gzip.'), { status: 400 });
  }
}

const answer = (status, body) => ({ status, body });

export async function handleSync({ method, path, query, headers, readBody }, { key, dataDir, store, address, limiter, limits = LIMITS }) {
  if (!key) return answer(404, { error: 'Sync is not set up on this server (no SYNC_KEY).' });
  const wait = limiter.blocked(address);
  if (wait) return answer(429, { error: tooManyMessage(wait) });
  if (!keyMatches(headers.authorization, key)) {
    limiter.fail(address);
    return answer(401, { error: 'Wrong or missing sync key.' });
  }
  const force = query.get('force') === '1';

  if (method === 'GET' && path === '/api/sync/selections') {
    if (!store?.ok) return answer(503, { error: store?.reason ?? 'Ratings are unavailable.' });
    return answer(200, { exportedAt: new Date().toISOString(), selections: store.all() });
  }
  const isSailings = method === 'PUT' && path === '/api/sync/sailings';
  const isSelections = method === 'PUT' && path === '/api/sync/selections';
  if (!isSailings && !isSelections) return answer(404, { error: 'Not found' });

  let text;
  let data;
  try {
    text = decode(await readBody(), headers['content-encoding'], limits).toString('utf8');
    data = JSON.parse(text);
  } catch (err) {
    return answer(err.status ?? 400, { error: err.status ? err.message : 'That upload is not valid JSON.' });
  }

  if (isSailings) {
    const was = await currentCount(dataDir);
    const problem = checkSailings(data, was, force);
    if (problem) return answer(problem.startsWith('Only ') ? 409 : 400, { error: problem });
    await storeSailings(dataDir, text);
    return answer(200, { stored: data.sailings.length, was });
  }

  if (!store?.ok) return answer(503, { error: store?.reason ?? 'Ratings are unavailable.' });
  const problem = checkRows(data?.selections);
  if (problem) return answer(400, { error: problem });
  const existing = store.all().length;
  if (existing > 0 && !force) {
    return answer(409, { error: `The server already has ${existing} saved cruises — nothing changed. Use --force to replace them.` });
  }
  return answer(200, { stored: store.replaceAll(data.selections) });
}
```

- [ ] **Step 6: `sync.js`** (the Mac's end)

```js
/**
 * The Mac's end of the sync: upload sailings.json, copy the server's ratings down, or (once)
 * push the Mac's ratings up. SYNC_URL + SYNC_KEY in .env turn it on.
 */
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

export function syncConfig(env = process.env) {
  if (!env.SYNC_URL || !env.SYNC_KEY) return null;
  const u = new URL(env.SYNC_URL);
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(`SYNC_URL must start with https:// (it is ${env.SYNC_URL}).`);
  }
  return { url: u.origin, key: env.SYNC_KEY };
}

const GZIP_JSON = { 'content-type': 'application/json', 'content-encoding': 'gzip' };

async function call(config, path, { method = 'GET', body, headers = {}, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${config.url}${path}`, { method, body, headers: { authorization: `Bearer ${config.key}`, ...headers } });
  } catch (err) {
    throw new Error(`Could not reach ${config.url} (${err.cause?.code ?? err.message}).`);
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* handled below */ }
  if (res.status === 401) throw new Error('The server refused the sync key — SYNC_KEY in .env must match the one on the server.');
  if (!res.ok) throw new Error(data?.error ?? `The server answered ${res.status}.`);
  if (data === null) throw new Error('The server’s answer was cut off or not JSON — nothing changed.');
  return data;
}

export async function uploadSailings({ config, dataFile, force = false, fetchImpl }) {
  const body = gzipSync(await readFile(dataFile));
  return call(config, `/api/sync/sailings${force ? '?force=1' : ''}`, { method: 'PUT', body, headers: GZIP_JSON, fetchImpl });
}

export async function pullRatings({ config, store, fetchImpl, now = () => new Date().toISOString() }) {
  if (!store?.ok) throw new Error(store?.reason ?? 'Ratings are unavailable on this Mac.');
  const { selections } = await call(config, '/api/sync/selections', { fetchImpl });
  return { copied: store.replaceAll(selections, { copiedAt: now() }) };
}

export async function pushRatings({ config, store, force = false, fetchImpl }) {
  if (!store?.ok) throw new Error(store?.reason ?? 'Ratings are unavailable on this Mac.');
  const body = gzipSync(Buffer.from(JSON.stringify({ selections: store.all() })));
  return call(config, `/api/sync/selections${force ? '?force=1' : ''}`, { method: 'PUT', body, headers: GZIP_JSON, fetchImpl });
}
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/sync.test.js test/selections.test.js`
Expected: PASS.

- [ ] **Step 8: `tools/sync.js` and scripts**

```js
// npm run upload-data | pull-ratings | push-ratings  [-- --force]
import { join } from 'node:path';
import { dataDir } from '../paths.js';
import { openSelections, DEFAULT_FILE } from '../selections.js';
import { syncConfig, uploadSailings, pullRatings, pushRatings } from '../sync.js';

const [command] = process.argv.slice(2);
const force = process.argv.includes('--force');

try {
  const config = syncConfig();
  if (!config) throw new Error('Set SYNC_URL and SYNC_KEY in .env first.');
  if (command === 'upload') {
    const { stored, was } = await uploadSailings({ config, dataFile: join(dataDir(), 'sailings.json'), force });
    console.log(`Uploaded: the server now has ${stored} sailings (was ${was}).`);
  } else if (command === 'pull' || command === 'push') {
    const store = await openSelections(process.env.SELECTIONS_FILE || DEFAULT_FILE);
    if (command === 'pull') {
      const { copied } = await pullRatings({ config, store });
      console.log(`Copied ${copied} saved cruises from the server.`);
    } else {
      const { stored } = await pushRatings({ config, store, force });
      console.log(`Sent ${stored} saved cruises to the server.`);
    }
  } else {
    throw new Error('Use: node tools/sync.js upload | pull | push [--force]');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

`package.json` scripts — add:

```json
    "upload-data": "node --env-file-if-exists=.env tools/sync.js upload",
    "pull-ratings": "node --env-file-if-exists=.env tools/sync.js pull",
    "push-ratings": "node --env-file-if-exists=.env tools/sync.js push"
```

- [ ] **Step 9: Wire `server.js`**

Imports: `import { dataDir } from './paths.js';`, `import { handleSync, LIMITS } from './sync-server.js';`, `import { syncConfig } from './sync.js';`, and `readRaw` from `./guard.js`.

Replace the `DATA_FILE` and `FLIGHTS_CACHE` constants:

```js
const DATA_DIR = dataDir();
const DATA_FILE = join(DATA_DIR, 'sailings.json');
const FLIGHTS_CACHE = join(DATA_DIR, 'flights-cache.json');
```

After the `auth` constants (Task 3):

```js
// The Mac's copy: SYNC_URL + SYNC_KEY. A bad SYNC_URL (plain http to a real host) stops the start.
let mirror;
try { mirror = syncConfig(process.env); } catch (err) { console.error(`Not starting: ${err.message}`); process.exit(1); }
const NO_DATA = deployed
  ? 'No data yet — upload it from the Mac with `npm run upload-data`.'
  : 'No data yet. Run `node scrape.js` first, then reload this page.';
```

Use `NO_DATA` in both 503 answers (`/api/dataset` and `/api/search`).

Replace the `/api/` guard call so sync routes get their own limit:

```js
    if (req.url.startsWith('/api/')) {
      const maxBody = path.startsWith('/api/sync/') ? LIMITS.maxCompressed : undefined;
      const refused = checkRequest({ method: req.method, headers: req.headers, maxBody });
      if (refused) return json(res, refused.status, { error: refused.error });
    }

    if (path.startsWith('/api/sync/')) {
      const out = await handleSync({
        method: req.method, path, query: new URL(req.url, 'http://x').searchParams, headers: req.headers,
        readBody: () => readRaw(req, LIMITS.maxCompressed),
      }, {
        key: process.env.SYNC_KEY ?? '', dataDir: DATA_DIR, store: selections, address: addressOf(req), limiter,
      });
      return json(res, out.status, out.body);
    }
```

`/api/status` becomes:

```js
      return json(res, 200, { login: auth.on, mirror: Boolean(mirror), ratingsCopiedAt: selections.ok ? selections.copiedAt() : null });
```

- [ ] **Step 10: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 11: End-to-end on two scratch copies (a "server" on 3031, the CLI as the Mac)**

```bash
SCRATCH=<session scratchpad>; D="$SCRATCH/deploy-check"; mkdir -p "$D/server" "$D/mac"
export SYNC_KEY=$(npm run -s make-key)
PORT=3031 DATA_DIR="$D/server" SELECTIONS_FILE="$D/server/selections.db" node server.js > "$D/server.log" 2>&1 &
sleep 1
cp data/sailings.json "$D/mac/sailings.json"
SYNC_URL=http://localhost:3031 DATA_DIR="$D/mac" node tools/sync.js upload
SYNC_URL=http://localhost:3031 DATA_DIR="$D/mac" node tools/sync.js upload
node -e "const f='$D/mac/sailings.json';const d=JSON.parse(require('fs').readFileSync(f));d.sailings=d.sailings.slice(0,10);require('fs').writeFileSync(f,JSON.stringify(d))"
SYNC_URL=http://localhost:3031 DATA_DIR="$D/mac" node tools/sync.js upload; echo "exit $?"
SYNC_URL=http://localhost:3031 SELECTIONS_FILE="$D/mac/selections.db" node tools/sync.js pull
SYNC_KEY=wrong-wrong-wrong-wrong-wrong-wrong-1 SYNC_URL=http://localhost:3031 node tools/sync.js pull; echo "exit $?"
curl -s http://127.0.0.1:3031/api/dataset | head -c 200; echo
```

Expected: first upload `the server now has 4291 sailings (was 0)` (whatever the current count is); second `(was 4291)`; the 10-sailing upload `Only 10 sailings — fewer than half … --force` and `exit 1`; the pull `Copied 0 saved cruises from the server.`; the wrong key `The server refused the sync key …` and `exit 1`; `/api/dataset` returns sailings JSON. Peter's `data/` is only read (`cp` from it). Stop the copy; `unset SYNC_KEY`.

- [ ] **Step 12: Commit**

```bash
git add paths.js sync-server.js sync.js tools/sync.js selections.js server.js scrape.js package.json test/sync.test.js test/selections.test.js
git commit -m "Sync the Mac and the server: upload sailings.json, copy ratings down, push them up once"
```

---

### Task 5: The Refresh button and progress panel

**Files:**
- Create: `refresh.js`, `public/refresh-panel.js`
- Modify: `progress.js` (`throttleMs`), `server.js` (refresh routes), `public/index.html` (button, panel, CSS), `public/index.js` (import the panel)
- Test: `test/refresh.test.js`, `test/progress.test.js`

**Interfaces:**
- Consumes: `syncConfig`, `uploadSailings`, `pullRatings` (Task 4); `formatDuration` (`progress.js`); `dataDir` (Task 4).
- Produces: `createRefresher({ sync: { upload, pull }|null, dataFile, run?, mtime?, now? }) → { status(), start(), stop(), retry(step) }`; `status() → { available, state, startedAt, lines, result: { text, failures: string[], retry: 'upload'|'pull'|null }|null }`; states `idle | running | uploading | pulling | done | failed | stopped`. Routes `GET /api/refresh`, `POST /api/refresh`, `POST /api/refresh/stop`, `POST /api/refresh/retry` `{ step }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/progress.test.js`:

```js
test('the throttle can be shortened (the Refresh panel asks for 2 s)', () => {
  const stream = fakeStream(false);
  const c = clock();
  const r = createReporter({ stream, now: c.now, throttleMs: 2000 });
  r.start('cunard');
  c.t = 2500;
  r.progress('cunard', 'page 3');
  assert.match(stream.text, /cunard: page 3\n/);
});
```

`test/refresh.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRefresher, MAX_LINES } from '../refresh.js';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.killed = null;
  c.kill = (signal) => { c.killed = signal; setImmediate(() => c.emit('close', null, signal)); };
  return c;
}
const settle = () => new Promise((r) => setImmediate(r));
async function until(check) {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await settle(); }
  throw new Error('timed out waiting');
}

/** A refresher with a fake scrape, fake file times and a fake clock. */
function rig({ upload = async () => ({ stored: 4300, was: 4291 }), pull = async () => ({ copied: 3 }), sync = true } = {}) {
  const t = { runs: 0, mtime: 1, clock: 0, child: null, uploads: 0, pulls: 0 };
  t.r = createRefresher({
    sync: sync ? { upload: async () => { t.uploads += 1; return upload(); }, pull: async () => { t.pulls += 1; return pull(); } } : null,
    dataFile: '/nowhere/sailings.json',
    run: () => { t.runs += 1; t.child = fakeChild(); return t.child; },
    mtime: async () => t.mtime,
    now: () => t.clock,
  });
  t.finish = async ({ code = 0, written = true, out = '' } = {}) => {
    if (out) t.child.stdout.write(out);
    await settle();
    if (written) t.mtime = 2;
    t.clock = 24 * 60_000 + 12_000;
    t.child.emit('close', code, null);
  };
  return t;
}

test('without SYNC_URL and SYNC_KEY there is no Refresh', async () => {
  const t = rig({ sync: false });
  assert.equal(t.r.status().available, false);
  assert.match((await t.r.start()).error, /SYNC_URL/);
  assert.equal(t.runs, 0);
});

test('one scrape at a time: a second start gets the running one', async () => {
  const t = rig();
  await t.r.start();
  const again = await t.r.start();
  assert.equal(t.runs, 1);
  assert.equal(again.state, 'running');
});

test('the panel gets the scrape’s lines, the last 500', async () => {
  const t = rig();
  await t.r.start();
  t.child.stdout.write(Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n') + '\n');
  t.child.stderr.write('cunard: page 3 · 20 priced\n');
  await settle();
  const { lines } = t.r.status();
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines.at(-1), 'cunard: page 3 · 20 priced');
});

test('success: upload, then copy the ratings, then say so', async () => {
  const t = rig();
  await t.r.start();
  await t.finish({ out: 'royal-caribbean: 2081 sailings (0:18)\n' });
  await until(() => t.r.status().state === 'done');
  assert.equal(t.r.status().result.text, 'Done in 24:12 — 4,300 sailings · uploaded to the server ✓ · ratings copied from the server ✓');
  assert.deepEqual(t.r.status().result.failures, []);
  assert.equal(t.uploads, 1);
  assert.equal(t.pulls, 1);
});

test('a line failed but the file was written: still uploaded, failures listed', async () => {
  const t = rig();
  await t.r.start();
  await t.finish({ code: 1, out: 'princess: kept 98 sailings from the previous run\n\n1 failure(s):\n  princess listing: timed out\n\nDone in 25:06\n' });
  await until(() => t.r.status().state === 'done');
  assert.deepEqual(t.r.status().result.failures, ['princess listing: timed out']);
  assert.equal(t.uploads, 1);
});

test('nothing written: nothing uploaded, and the panel says the server keeps its data', async () => {
  const t = rig();
  await t.r.start();
  await t.finish({ code: 1, written: false });
  await until(() => t.r.status().state === 'failed');
  assert.equal(t.r.status().result.text, 'Nothing changed — the server keeps its data.');
  assert.equal(t.uploads, 0);
});

test('Stop ends the scrape; nothing is uploaded', async () => {
  const t = rig();
  await t.r.start();
  t.r.stop();
  assert.equal(t.child.killed, 'SIGTERM');
  await until(() => t.r.status().state === 'stopped');
  assert.match(t.r.status().result.text, /Stopped/);
  assert.equal(t.uploads, 0);
});

test('a failed upload can be tried again on its own', async () => {
  let fail = true;
  const t = rig({ upload: async () => { if (fail) throw new Error('Could not reach https://x (ECONNREFUSED).'); return { stored: 4300, was: 4291 }; } });
  await t.r.start();
  await t.finish();
  await until(() => t.r.status().state === 'failed');
  assert.match(t.r.status().result.text, /upload failed: Could not reach/);
  assert.equal(t.r.status().result.retry, 'upload');
  fail = false;
  t.r.retry('upload');
  await until(() => t.r.status().state === 'done');
  assert.equal(t.runs, 1, 'no second scrape');
});

test('a failed ratings copy is retried without uploading again', async () => {
  let fail = true;
  const t = rig({ pull: async () => { if (fail) throw new Error('The server answered 503.'); return { copied: 1 }; } });
  await t.r.start();
  await t.finish();
  await until(() => t.r.status().state === 'failed');
  assert.equal(t.r.status().result.retry, 'pull');
  assert.match(t.r.status().result.text, /uploaded to the server ✓ · copying ratings failed/);
  fail = false;
  t.r.retry('pull');
  await until(() => t.r.status().state === 'done');
  assert.equal(t.uploads, 1);
});

test('a scrape that cannot start says so, instead of staying "running"', async () => {
  const t = rig();
  await t.r.start();
  t.child.emit('error', new Error('spawn node ENOENT'));
  t.child.emit('close', -2, null);
  await until(() => t.r.status().state === 'failed');
  assert.match(t.r.status().result.text, /could not start: spawn node ENOENT/);
  assert.equal(t.uploads, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/refresh.test.js test/progress.test.js`
Expected: FAIL — `Cannot find module '../refresh.js'`; the throttle test fails (no output before 15 s).

- [ ] **Step 3: `progress.js`** — the reporter takes a throttle:

```js
export function createReporter({
  stream = process.stdout, now = Date.now,
  // The Refresh panel runs the scrape with SCRAPE_PROGRESS_MS=2000: a log line every 15 s
  // looks stuck in a panel someone is watching.
  throttleMs = Number(process.env.SCRAPE_PROGRESS_MS) || THROTTLE_MS,
} = {}) {
```

and in `progress()` use `throttleMs` instead of `THROTTLE_MS`.

- [ ] **Step 4: `refresh.js`**

```js
/**
 * The Mac's Refresh: runs the scrape as a child process, keeps its lines for the panel, then
 * uploads sailings.json and copies the server's ratings. One at a time. Lives in the server
 * process: closing the tab doesn't stop it; stopping the server does.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { formatDuration } from './progress.js';

export const MAX_LINES = 500;
const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
const BUSY = new Set(['running', 'uploading', 'pulling']);

/** REFRESH_ARGS adds flags for checks (e.g. "--site viking --limit 5"); a real Refresh has none. */
export function defaultRun(args = (process.env.REFRESH_ARGS ?? '').split(/\s+/).filter(Boolean)) {
  return spawn(process.execPath, ['scrape.js', ...args], {
    cwd: APP_DIR,
    env: { ...process.env, SCRAPE_PROGRESS_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const mtimeOf = async (file) => {
  try { return (await stat(file)).mtimeMs; } catch { return 0; }
};

export function createRefresher({ sync, dataFile, run = defaultRun, mtime = mtimeOf, now = Date.now }) {
  let state = 'idle';
  let startedAt = null;
  let startMs = 0;
  let lines = [];
  let result = null;
  let child = null;
  let stopping = false;
  let before = 0;
  let summary = null; // { took, failures } once the scrape has ended with a written file
  let uploaded = null;

  const add = (text) => {
    for (const line of String(text).split(/\r\n|\n|\r/)) if (line.trim()) lines.push(line);
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  };

  /** The block scrape.js prints at the end: "N failure(s):" then indented lines. */
  const failuresIn = () => {
    const i = lines.findLastIndex((l) => /^\d+ failure\(s\):$/.test(l));
    if (i < 0) return [];
    const out = [];
    for (const l of lines.slice(i + 1)) {
      if (!/^\s{2}\S/.test(l)) break;
      out.push(l.trim());
    }
    return out;
  };

  const count = () => uploaded.stored.toLocaleString('en-US');

  async function syncFrom(step) {
    const { took, failures } = summary;
    if (step === 'upload') {
      state = 'uploading';
      try {
        uploaded = await sync.upload();
      } catch (err) {
        state = 'failed';
        result = { text: `Done in ${took}, but the upload failed: ${err.message}`, failures, retry: 'upload' };
        return;
      }
    }
    state = 'pulling';
    try {
      await sync.pull();
    } catch (err) {
      state = 'failed';
      result = { text: `Done in ${took} — ${count()} sailings · uploaded to the server ✓ · copying ratings failed: ${err.message}`, failures, retry: 'pull' };
      return;
    }
    state = 'done';
    result = { text: `Done in ${took} — ${count()} sailings · uploaded to the server ✓ · ratings copied from the server ✓`, failures, retry: null };
  }

  let ended = false;
  async function end({ code, error }) {
    if (ended) return;
    ended = true;
    child = null;
    const failures = failuresIn();
    if (error) {
      state = 'failed';
      result = { text: `The scrape could not start: ${error.message}`, failures: [], retry: null };
      return;
    }
    if (stopping) {
      state = 'stopped';
      result = { text: 'Stopped — nothing changed; the server keeps its data.', failures: [], retry: null };
      return;
    }
    if ((await mtime(dataFile)) === before) {
      state = 'failed';
      result = { text: 'Nothing changed — the server keeps its data.', failures, retry: null };
      return;
    }
    summary = { took: formatDuration(now() - startMs), failures, code };
    await syncFrom('upload');
  }

  const status = () => ({ available: Boolean(sync), state, startedAt, lines: [...lines], result });

  return {
    status,

    async start() {
      if (!sync) return { ...status(), error: 'Refresh needs SYNC_URL and SYNC_KEY in .env.' };
      if (BUSY.has(state)) return status();
      state = 'running';
      lines = [];
      result = null;
      stopping = false;
      ended = false;
      summary = null;
      uploaded = null;
      startMs = now();
      startedAt = new Date().toISOString();
      before = await mtime(dataFile);
      child = run();
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      child.on('error', (error) => { add(`Could not start the scrape: ${error.message}`); end({ error }); });
      child.on('close', (code) => { setImmediate(() => end({ code })); });
      return status();
    },

    stop() {
      if (state === 'running' && child) {
        stopping = true;
        child.kill('SIGTERM');
      }
      return status();
    },

    retry(step) {
      if (state === 'failed' && result?.retry === step && summary) syncFrom(step);
      return status();
    },
  };
}
```

(`close` defers `end` by a tick so an `error` emitted just before it wins — the spawn-error test emits both.)

- [ ] **Step 5: Run the tests**

Run: `node --test test/refresh.test.js test/progress.test.js`
Expected: PASS.

- [ ] **Step 6: Server routes** — in `server.js`: `import { createRefresher } from './refresh.js';` and `import { uploadSailings, pullRatings } from './sync.js';` (extend the Task 4 import). After `selections` is opened:

```js
const refresher = createRefresher({
  dataFile: DATA_FILE,
  sync: mirror && {
    upload: () => uploadSailings({ config: mirror, dataFile: DATA_FILE }),
    pull: () => pullRatings({ config: mirror, store: selections }),
  },
});
```

In the handler, after the sync routes:

```js
    if (path === '/api/refresh' || path.startsWith('/api/refresh/')) {
      if (req.method === 'GET' && path === '/api/refresh') return json(res, 200, refresher.status());
      if (!mirror) return json(res, 404, { error: 'Refresh needs SYNC_URL and SYNC_KEY in .env.' });
      const body = await readBody(req);
      if (req.method === 'POST' && path === '/api/refresh') return json(res, 202, await refresher.start());
      if (req.method === 'POST' && path === '/api/refresh/stop') return json(res, 200, refresher.stop());
      if (req.method === 'POST' && path === '/api/refresh/retry') {
        let step = null;
        try { ({ step } = JSON.parse(body || '{}')); } catch { /* step stays null */ }
        return json(res, 200, refresher.retry(step));
      }
      return json(res, 404, { error: 'Not found' });
    }
```

- [ ] **Step 7: The panel** — `public/index.html`: in `#results-bar`, before `<span id="results-note">`:

```html
<button id="refresh" type="button" class="refresh" hidden>Refresh data</button>
```

after the `#results-bar` div:

```html
  <section id="refresh-panel" class="refresh-panel" hidden aria-live="polite">
    <pre id="refresh-lines" class="refresh-lines"></pre>
    <div id="refresh-result" class="refresh-result"></div>
    <div class="refresh-actions">
      <button id="refresh-new" type="button" hidden>Show the new data</button>
      <button id="refresh-retry" type="button" hidden>Try again</button>
      <button id="refresh-stop" type="button" hidden>Stop</button>
      <button id="refresh-hide" type="button">Hide</button>
    </div>
  </section>
```

CSS:

```css
  .refresh { font: inherit; font-size: 13px; font-weight: 600; padding: 4px 10px; border: 1px solid var(--line);
    border-radius: 999px; background: transparent; color: var(--accent); cursor: pointer; }
  .refresh-panel { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: -4px 0 14px; }
  .refresh-lines { margin: 0; max-height: 220px; overflow: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; color: var(--muted); }
  .refresh-result { margin-top: 8px; font-size: 14px; }
  .refresh-result div + div { color: var(--muted); font-size: 13px; }
  .refresh-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .refresh-actions button { font: inherit; font-size: 13px; padding: 4px 10px; border: 1px solid var(--line);
    border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
```

`public/refresh-panel.js`:

```js
// The Mac's Refresh button and its progress panel. The button shows only when the server
// says a Refresh is possible (SYNC_URL + SYNC_KEY); the deployed site never shows it.
const $ = (q) => document.querySelector(q);
const BUSY = new Set(['running', 'uploading', 'pulling']);
const LABEL = { running: 'Refreshing…', uploading: 'Uploading…', pulling: 'Copying ratings…' };
let timer = null;
let stopArmed = null;

async function call(method, path, body) {
  const res = await fetch(path, method === 'GET' ? {} : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

function draw(s) {
  $('#refresh').hidden = !s.available;
  $('#refresh').textContent = LABEL[s.state] ?? 'Refresh data';
  const pre = $('#refresh-lines');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = s.lines.join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  const r = s.result;
  const texts = r ? [r.text, ...r.failures.map((f) => `• ${f}`)] : [];
  $('#refresh-result').replaceChildren(...texts.map((t) => Object.assign(document.createElement('div'), { textContent: t })));
  $('#refresh-stop').hidden = s.state !== 'running';
  $('#refresh-retry').hidden = !r?.retry;
  $('#refresh-retry').dataset.step = r?.retry ?? '';
  // New data is on this Mac once the file was written: done, or a failed upload/copy.
  $('#refresh-new').hidden = !(s.state === 'done' || (s.state === 'failed' && r?.retry));
  clearTimeout(timer);
  if (BUSY.has(s.state)) timer = setTimeout(poll, 2000);
}

async function poll() { draw(await call('GET', '/api/refresh')); }

$('#refresh').addEventListener('click', async () => {
  $('#refresh-panel').hidden = false;
  const s = await call('GET', '/api/refresh');
  draw(BUSY.has(s.state) ? s : await call('POST', '/api/refresh'));
});
$('#refresh-hide').addEventListener('click', () => { $('#refresh-panel').hidden = true; });
// Stop throws away up to 25 minutes of scraping: two clicks, as /mine's Remove.
$('#refresh-stop').addEventListener('click', async () => {
  const b = $('#refresh-stop');
  if (!stopArmed) {
    b.textContent = 'Stop? Click again';
    stopArmed = setTimeout(() => { b.textContent = 'Stop'; stopArmed = null; }, 4000);
    return;
  }
  clearTimeout(stopArmed);
  stopArmed = null;
  b.textContent = 'Stop';
  draw(await call('POST', '/api/refresh/stop'));
});
$('#refresh-retry').addEventListener('click', async () => {
  draw(await call('POST', '/api/refresh/retry', { step: $('#refresh-retry').dataset.step }));
});
$('#refresh-new').addEventListener('click', () => location.reload());

// A Refresh already running (another tab, or before a reload) opens the panel.
call('GET', '/api/refresh').then((s) => {
  if (BUSY.has(s.state)) $('#refresh-panel').hidden = false;
  draw(s);
});
```

In `public/index.js`, after the `session.js` import: `import '/refresh-panel.js';`

- [ ] **Step 8: Run the suite**

Run: `npm test`
Expected: all pass (the pages test covers the new script).

- [ ] **Step 9: Headless check of a real (small) Refresh against scratch copies**

```bash
SCRATCH=<session scratchpad>; D="$SCRATCH/deploy-check"; rm -rf "$D/server" "$D/mac"; mkdir -p "$D/server" "$D/mac"
export SYNC_KEY=$(npm run -s make-key)
PORT=3031 DATA_DIR="$D/server" SELECTIONS_FILE="$D/server/selections.db" node server.js > "$D/server.log" 2>&1 &
cp data/sailings.json "$D/mac/sailings.json"
PORT=3032 DATA_DIR="$D/mac" SELECTIONS_FILE="$D/mac/selections.db" SYNC_URL=http://localhost:3031 REFRESH_ARGS="--site viking --limit 5" node server.js > "$D/mac.log" 2>&1 &
sleep 1
```

(The Mac copy's scrape writes `$D/mac/sailings.json` — scratch — keeping the other five lines from the copied file, so the upload clears the half-check.)

Write `$SCRATCH/deploy-check/refresh-check.mjs` (puppeteer, as Task 2's check): open `http://localhost:3032/`, wait for `.card`, assert `#refresh` is visible, click it, assert `#refresh-panel` is visible and `#refresh` reads `Refreshing…`, record the first `#refresh-lines` text, wait (up to 5 min) until `#refresh-result` contains `Done in`, print that text, assert `.card` count is unchanged while it ran, click `#refresh-new` and wait for the reload. Then open `http://localhost:3031/` (no `SYNC_URL`) and assert `#refresh` is hidden.

Run: `node "$SCRATCH/deploy-check/refresh-check.mjs"`
Expected: lines appear (`viking: fetching…` …); result `Done in 0:xx — 4,2xx sailings · uploaded to the server ✓ · ratings copied from the server ✓`; the server copy (3031) shows no Refresh button; `curl -s localhost:3031/api/dataset | node -e "…sailings.length"` matches the uploaded count. Stop both copies; `unset SYNC_KEY`.

- [ ] **Step 10: Commit**

```bash
git add refresh.js progress.js server.js public/refresh-panel.js public/index.html public/index.js test/refresh.test.js test/progress.test.js
git commit -m "Add a Refresh button on the Mac: scrape with live progress, then upload and copy the ratings"
```

---

### Task 6: Container, health check, local HTTPS with Caddy

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `health.js`, `tools/Caddyfile.local`
- Modify: `server.js` (`/healthz`)
- Test: `test/health.test.js`

**Interfaces:**
- Produces: `health({ selections, dataFile }) → Promise<{ status: 200|503, text }>`; `GET /healthz`.

- [ ] **Step 1: Write the failing test** — `test/health.test.js`:

```js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { health } from '../health.js';

const dir = mkdtempSync(join(tmpdir(), 'health-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, text) => { const f = join(dir, name); if (text !== undefined) writeFileSync(f, text); return f; };

test('healthy with data and ratings', async () => {
  assert.deepEqual(await health({ selections: { ok: true }, dataFile: file('ok.json', '{"sailings":[]}') }), { status: 200, text: 'ok' });
});

test('no data yet is still healthy — the first deploy starts empty', async () => {
  assert.deepEqual(await health({ selections: { ok: true }, dataFile: file('missing.json') }), { status: 200, text: 'ok — no data yet' });
});

test('unreadable data or ratings are unhealthy, and say nothing more', async () => {
  assert.equal((await health({ selections: { ok: true }, dataFile: file('bad.json', '{oops') })).status, 503);
  assert.equal((await health({ selections: { ok: false, reason: 'x' }, dataFile: file('ok2.json', '{}') })).status, 503);
  assert.equal((await health({ selections: { ok: false, reason: 'secret path' }, dataFile: file('ok3.json', '{}') })).text, 'unhealthy');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/health.test.js`
Expected: FAIL — `Cannot find module '../health.js'`.

- [ ] **Step 3: `health.js`**

```js
/**
 * For Coolify's health check — unlocked, so it says nothing but ok or unhealthy. No data yet
 * is healthy: the first deploy starts with an empty volume until the Mac uploads.
 */
import { readFile } from 'node:fs/promises';

export async function health({ selections, dataFile }) {
  if (!selections?.ok) return { status: 503, text: 'unhealthy' };
  try {
    JSON.parse(await readFile(dataFile, 'utf8'));
    return { status: 200, text: 'ok' };
  } catch (err) {
    return err.code === 'ENOENT' ? { status: 200, text: 'ok — no data yet' } : { status: 503, text: 'unhealthy' };
  }
}
```

In `server.js` (`import { health } from './health.js';`), before the `/login` route:

```js
    if (req.method === 'GET' && path === '/healthz') {
      const h = await health({ selections, dataFile: DATA_FILE });
      res.writeHead(h.status, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(h.text);
    }
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: `Dockerfile` and `.dockerignore`**

`Dockerfile`:

```dockerfile
# The server only: the Mac scrapes and uploads (docs/superpowers/specs/2026-10-16-deployment-design.md).
# No Chromium, so puppeteer's browser download is skipped.
FROM node:24.22-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true HOST=0.0.0.0 PORT=3030
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
# The volume mounts here; created owned by node so a new named volume starts writable.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3030/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
```

`.dockerignore`:

```text
.env
.env.*
data/
node_modules/
.git/
.superpowers/
docs/
test/
.DS_Store
*.md
!package.json
```

- [ ] **Step 6: `tools/Caddyfile.local`**

```caddyfile
# Local HTTPS in front of a second copy on port 3031, so the Mac behaves like the deployed
# site: HTTPS, Secure cookies, and a proxy adding X-Forwarded-For as Coolify's does.
#   caddy run --config tools/Caddyfile.local --adapter caddyfile
# Browsers trust it after `caddy trust` (asks for the Mac's password) — Peter's step.
{
	local_certs
	skip_install_trust
	http_port 8080
	auto_https disable_redirects
}

https://localhost:8443 {
	reverse_proxy 127.0.0.1:3031
}
```

Run: `caddy validate --config tools/Caddyfile.local --adapter caddyfile`
Expected: `Valid configuration`.

- [ ] **Step 7: Build and run the container locally, behind Caddy** (Docker Desktop must be running; ask Peter if it isn't)

```bash
SCRATCH=<session scratchpad>; D="$SCRATCH/deploy-check"; rm -rf "$D/vol"; mkdir -p "$D/vol"
docker build -t ai-cruises:check . > "$D/build.log" 2>&1; echo "build exit $?"; docker images ai-cruises:check --format '{{.Size}}'
docker run --rm -e HOST=0.0.0.0 ai-cruises:check 2>&1 | head -3
JWT=$(npm run -s make-key); KEY=$(npm run -s make-key)
HASH=$(node -e "import('./auth.js').then(a => console.log(a.hashPassword('check password 123')))")
docker run -d --name ai-cruises-check -p 127.0.0.1:3031:3030 -v ai-cruises-check-vol:/app/data \
  -e JWT_SECRET="$JWT" -e LOGIN_PASSWORD_HASH="$HASH" -e SYNC_KEY="$KEY" -e TRUST_PROXY=1 ai-cruises:check
caddy start --config tools/Caddyfile.local --adapter caddyfile > "$D/caddy.log" 2>&1
sleep 3
CA="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt"
curl -s --cacert "$CA" https://localhost:8443/healthz; echo
NODE_EXTRA_CA_CERTS="$CA" SYNC_URL=https://localhost:8443 SYNC_KEY="$KEY" DATA_DIR="$PWD/data" node tools/sync.js upload
curl -s --cacert "$CA" https://localhost:8443/healthz; echo
docker exec ai-cruises-check ls -la /app/data
```

Expected: `build exit 0`, size ~250 MB (report the real number); the bare run prints `Not starting:` / `Login is required when HOST is 0.0.0.0…`; `/healthz` first `ok — no data yet`, then after the upload `ok`; the upload says `the server now has N sailings (was 0)`; `/app/data` holds `sailings.json` owned by `node`. (The upload only *reads* `data/sailings.json`.)

Then the login through HTTPS, headless — `$D/https-check.mjs` (puppeteer with `acceptInsecureCerts: true`, so Peter's `caddy trust` is not needed for this): open `https://localhost:8443/` → lands on `/login`; type `check password 123`; lands on `/` with cards; read the `session` cookie's `secure`/`httpOnly`/`sameSite` from `page.cookies()`; check the response headers of `/` include `cache-control: no-store` and the CSP, and **no** `strict-transport-security` (host is localhost); rate a cruise; click "Log out"; press Back and confirm it lands on `/login`, not cached cards. Then, with plain `curl --cacert`, make 5 wrong logins and a 6th with `-H 'x-forwarded-for: 1.2.3.4'`: still 429 (Caddy's own entry is last).

Run: `node "$D/https-check.mjs"`
Expected: every assertion prints `ok`, CSP violations 0.

Clean up: `caddy stop; docker rm -f ai-cruises-check; docker volume rm ai-cruises-check-vol; docker rmi ai-cruises:check`.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore health.js tools/Caddyfile.local server.js test/health.test.js
git commit -m "Add the server's container (Node 24.22, no Chromium), a health check, and local HTTPS with Caddy"
```

---

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CLAUDE.md`**

- **Running it:** add `npm run upload-data`, `npm run pull-ratings`, `npm run push-ratings` (`-- --force`), `npm run hash-password`, `npm run make-key`, and the Caddy line `caddy run --config tools/Caddyfile.local --adapter caddyfile` (HTTPS at `https://localhost:8443` → port 3031).
- **Environment:** `DATA_DIR`; that `HOST` other than localhost needs the login and working ratings or the server refuses to start; `SCRAPE_PROGRESS_MS`; `REFRESH_ARGS` (checks only).
- **New section `## Deployment`** (after Environment): the two roles (Mac: no login, `SYNC_URL`/`SYNC_KEY`, Refresh button; server: login, `/api/sync/*`, no scraping); the settings table from the spec; Refresh → upload → pull, the half-size refusal and `--force`; the mirror note; login facts (one user, 30 days, a new password or `JWT_SECRET` logs out everywhere, 5 guesses per 15 minutes, `TRUST_PROXY=1` reads the last `X-Forwarded-For`); security headers (scripts only from files — never add an inline `<script>` or `onclick=`, `test/pages.test.js` fails); `/healthz`; Dockerfile (Node 24.22, no Chromium); that private details (server address, Coolify IDs) live in `~/Projects/deployment-notes.md`, never in this public repo. Spec link.
- **Princess quirks:** add "**A fresh tab per ship.** One tab reused for 17 results pages held 3.3 GB by the end (2026-10-16); a tab per ship, closed afterwards, peaks ~1.4 GB."
- **Status:** the new test count (from `npm test`).

- [ ] **Step 2: Run the suite and check the count matches the docs**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|fail)'`
Expected: `ℹ fail 0`, and the `tests` number is the one written in Status.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Record the deployment, the sync commands and the login in the project notes"
```

---

## After the branch merges — the first deploy (with Peter)

Not tasks for an executor: Peter does the dashboard and DNS steps; Claude gives each one and runs the Mac-side commands.

1. **Hover:** A record, host `ai-cruises`, value `87.99.129.19`.
2. **Secrets, on the Mac:** `npm run make-key` twice (JWT_SECRET, SYNC_KEY), `npm run hash-password` once. `SYNC_URL=https://ai-cruises.peter-jones.org` and `SYNC_KEY=…` go in the Mac's `.env`.
   Before setting SYNC_URL on the Mac: `npm run export-selections` (a backup).
3. **Coolify:** new application from `peterajones/ai-cruises`, branch `main`, build pack Dockerfile, port 3030; persistent storage → `/app/data`; environment `JWT_SECRET`, `LOGIN_PASSWORD_HASH`, `SYNC_KEY`, `TRUST_PROXY=1`, `ANTHROPIC_API_KEY`, `SERP_API_KEY`; domain `https://ai-cruises.peter-jones.org`; deploy webhook as peterjonesdev2027's. Deploy.
4. **Check:** `curl https://ai-cruises.peter-jones.org/healthz` → `ok — no data yet`; the site shows the login.
5. **Data:** `npm run upload-data`. **Ratings:** `npm run push-ratings` (once) — before any `pull-ratings` or Refresh, which refuse until a push or pull has happened. A successful push marks the Mac as matching the server, so after it Refresh and `pull-ratings` work normally.
6. **Phone:** log in, rate a cruise. **Mac:** `npm run pull-ratings` → it arrives (the pull works because step 5's push marked the Mac as matching); the Mac's page shows the mirror note.
7. **Notes:** add the URL and Coolify app to `~/Projects/deployment-notes.md`; check whether `backups-dashboard` covers the volume and say which.
