/**
 * Zero-dependency HTTP server for the cruise search.
 *
 *   node server.js   ->   http://localhost:3030
 *
 * Listens on 127.0.0.1 only (this Mac) unless HOST says otherwise — a container needs
 * HOST=0.0.0.0 so its proxy can reach it. Every /api/ request passes guard.js first.
 *
 * Serves the page, and one API endpoint that runs a plain-English query through
 * brain.js (the model) and then search.js (ordinary conditionals).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { understand } from './brain.js';
import {
  searchSailings, emptyMessage, describeFilter, hasNoConstraints, applyPriceDirection,
  currencyNote, upcoming, localDate, usesSelections,
} from './search.js';
import { deriveValues } from './values.js';
import { flightsFor } from './flights.js';
import {
  openSelections, handleSelections, selectionMap, DEFAULT_FILE as SELECTIONS_DEFAULT,
} from './selections.js';
import { checkRequest, readBody, readRaw } from './guard.js';
import { dataDir } from './paths.js';
import { handleSync, LIMITS } from './sync-server.js';
import { syncConfig } from './sync.js';
import {
  authConfig, startupProblems, isOpenPath, attemptLogin, verifyToken, signToken, sessionCookie,
  clearedCookie, readCookie, createLimiter, clientAddress, isLocalHost,
} from './auth.js';
import { securityHeaders } from './headers.js';

// PORT lets a second copy run beside the usual one, e.g. to check a change.
const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '127.0.0.1';
const auth = authConfig(process.env);
const deployed = !isLocalHost(HOST);
const trustProxy = process.env.TRUST_PROXY === '1';
// The Mac's copy: SYNC_URL + SYNC_KEY. A bad SYNC_URL (plain http to a real host) stops the start.
let mirror;
try { mirror = syncConfig(process.env); } catch (err) { console.error(`Not starting: ${err.message}`); process.exit(1); }
const NO_DATA = deployed
  ? 'No data yet — upload it from the Mac with `npm run upload-data`.'
  : 'No data yet. Run `node scrape.js` first, then reload this page.';
// Wrong passwords and wrong sync keys share one count per address.
const limiter = createLimiter();
const addressOf = (req) => clientAddress({
  socketAddress: req.socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'], trustProxy,
});
const signedIn = (req) => Boolean(verifyToken(readCookie(req.headers.cookie, 'session'), auth));
const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname;
const DATA_DIR = dataDir();
const DATA_FILE = join(DATA_DIR, 'sailings.json');
const FLIGHTS_CACHE = join(DATA_DIR, 'flights-cache.json');
// SELECTIONS_FILE points a second copy (port 3031) at a scratch database, so checks never
// touch Peter's ratings.
const SELECTIONS_FILE = process.env.SELECTIONS_FILE || SELECTIONS_DEFAULT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let dataset;
let loadedMtime = 0;

/**
 * Reloads when data/sailings.json changes on disk.
 *
 * The first version read the file once at startup, so a re-scrape while the
 * server was running left it serving stale data indefinitely — which is how
 * broken image URLs survived being fixed. Cheap to check: one stat per request.
 */
async function loadDataset() {
  let mtime;
  try {
    mtime = (await stat(DATA_FILE)).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  if (dataset && mtime === loadedMtime) return dataset;

  const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8'));

  if (loadedMtime !== 0) {
    console.log(`data/sailings.json changed — reloaded ${parsed.sailings.length} sailings`);
  }
  loadedMtime = mtime;
  dataset = parsed;
  return dataset;
}

/**
 * The dataset as of today: departed sailings removed, and the value lists
 * re-derived from what is left, so the model is never offered a destination or
 * port that only a departed sailing had. Built per request (see `upcoming`).
 */
function current(data) {
  const sailings = upcoming(data.sailings, localDate());
  const values = deriveValues(sailings);
  // `ship` is not in the scraper's derived enumeration, but the model needs it
  // to answer "on the Icon of the Seas". Derive it here from the same data so
  // it still cannot drift.
  values.ship = [...new Set(sailings.map((s) => s.ship))].sort();
  return { ...data, sailings, values };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function dateRange(sailings) {
  const dates = sailings.map((s) => s.departureDate).sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

const server = createServer(async (req, res) => {
  try {
    // Before any route answers: setHeader values merge into every writeHead below.
    for (const [name, value] of Object.entries(securityHeaders({ deployed, host: req.headers.host, login: auth.on }))) {
      res.setHeader(name, value);
    }
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

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }

    if (req.method === 'GET' && (req.url === '/mine' || req.url === '/mine.html')) {
      const html = await readFile(join(PUBLIC_DIR, 'mine.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }

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

    if (req.method === 'POST' && path === '/api/login') {
      if (!auth.on) return json(res, 404, { error: 'The login is off on this copy.' });
      let password;
      try { ({ password } = JSON.parse(await readBody(req) || '{}')); } catch { password = null; }
      // No await from here: the count and the check happen together (see attemptLogin).
      const out = attemptLogin(password, { address: addressOf(req), limiter, passwordHash: auth.passwordHash });
      if (out.status !== 204) return json(res, out.status, { error: out.error });
      res.writeHead(204, { 'set-cookie': sessionCookie(signToken(auth)) });
      return res.end();
    }

    if (req.method === 'POST' && path === '/api/logout') {
      res.writeHead(204, { 'set-cookie': clearedCookie() });
      return res.end();
    }

    if (req.method === 'GET' && path === '/api/status') {
      return json(res, 200, { login: auth.on, mirror: Boolean(mirror), ratingsCopiedAt: selections.ok ? selections.copiedAt() : null });
    }

    // What the page needs on load: the facets, and the whole dataset to render.
    if (req.method === 'GET' && req.url === '/api/dataset') {
      dataset = await loadDataset();
      if (!dataset) {
        return json(res, 503, { error: NO_DATA });
      }
      const view = current(dataset);
      return json(res, 200, {
        scrapedAt: view.scrapedAt,
        values: view.values,
        ships: view.ships,
        sailings: view.sailings,
      });
    }

    if (req.method === 'POST' && req.url === '/api/search') {
      dataset = await loadDataset();
      if (!dataset) {
        return json(res, 503, { error: NO_DATA });
      }

      const body = await readBody(req);
      let q;
      try {
        ({ q } = JSON.parse(body || '{}'));
      } catch {
        return json(res, 400, { error: 'That request was not valid JSON.' });
      }

      if (!q || !q.trim()) return json(res, 400, { error: 'Ask for something.' });

      const view = current(dataset);
      const started = Date.now();
      const { filter: modelFilter, raw, error } = await understand(
        q,
        view.values,
        dateRange(view.sailings),
      );

      if (error) return json(res, 502, { error, raw });

      // Deterministic correction of a rule the model gets wrong (see search.js).
      const filter = applyPriceDirection(q, modelFilter);

      // A filter that constrains nothing would match every sailing. If the model
      // also reported things it could not express, that "match everything" is a
      // lie dressed as an answer — return nothing and say why instead.
      const understoodNothing = hasNoConstraints(filter);

      const mine = selectionMap(selections);
      // Asked about ratings while they can't be read: say so, rather than ignore the ask.
      const ratingsMissing = !selections.ok && usesSelections(filter);

      const results = understoodNothing || ratingsMissing ? [] : searchSailings(view.sailings, filter, mine);

      // A price filter spanning currencies is imprecise, not invalid. Say so
      // alongside the results rather than withholding them — this is a tool for
      // finding interesting cruises, and an approximate list beats an error.
      //
      // Judge the CANDIDATES the price filter was applied to, not the survivors.
      // Checking the survivors gets it exactly backwards: if the comparison wrongly
      // excluded every CAD sailing, what is left is uniformly USD and the notice
      // goes quiet at the one moment it matters.
      const candidates = understoodNothing
        ? []
        : searchSailings(view.sailings, { ...filter, minPrice: null, maxPrice: null }, mine);
      const currency = currencyNote(candidates, filter);

      return json(res, 200, {
        filter,
        results,
        understood: describeFilter(filter),
        understoodNothing,
        message: ratingsMissing
          ? 'Ratings are unavailable right now.'
          : results.length === 0 ? emptyMessage(filter) : null,
        notice: currency?.note ?? null,
        tookMs: Date.now() - started,
      });
    }

    if (req.url.startsWith('/api/selections')) {
      dataset = await loadDataset();
      const body = req.method === 'GET' ? '' : await readBody(req);
      const out = handleSelections(
        { method: req.method, path: req.url.split('?')[0], body },
        { store: selections, sailings: dataset ? current(dataset).sailings : [] },
      );
      return json(res, out.status, out.body);
    }

    if (req.method === 'GET' && req.url.startsWith('/api/flights?')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const home = (params.get('home') ?? '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(home)) {
        return json(res, 400, { reason: 'bad-home', message: 'Use a three-letter airport code, like YYZ.' });
      }
      dataset = await loadDataset();
      const sailing = dataset?.sailings.find((s) => s.id === params.get('id'));
      if (!sailing) return json(res, 404, { reason: 'not-found', message: 'No such sailing.' });
      return json(res, 200, await flightsFor(sailing, home, {
        today: localDate(), apiKey: process.env.SERP_API_KEY, cacheFile: FLIGHTS_CACHE,
      }));
    }

    // The page imports the same filter rules the server uses (priceFor), so the
    // dropdown and the search can never disagree. search.js has no imports.
    if (req.method === 'GET' && req.url === '/search.js') {
      const js = await readFile(new URL('./search.js', import.meta.url));
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(js);
    }

    // Static assets from public/, path-traversal guarded.
    if (req.method === 'GET') {
      const safe = join(PUBLIC_DIR, req.url.replace(/\.\./g, '').split('?')[0]);
      if (safe.startsWith(PUBLIC_DIR)) {
        const file = await readFile(safe);
        res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream' });
        return res.end(file);
      }
    }

    res.writeHead(404).end('Not found');
  } catch (err) {
    if (err.code === 'ENOENT') return res.writeHead(404).end('Not found');
    if (err.status === 413) return json(res, 413, { error: err.message });
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

dataset = await loadDataset();
const selections = await openSelections(SELECTIONS_FILE);

// A server that others can reach must not start half-protected: no login, or ratings that
// silently don't save. On this Mac (127.0.0.1) the app still runs without ratings and says why.
const problems = startupProblems({ env: process.env, host: HOST, selections });
if (problems.length > 0) {
  console.error('Not starting:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

// The likeliest way to fail on startup is a server you already have running.
// Node's default is an unhandled 'error' event: a 20-line stack trace whose
// actual meaning — "it's already up" — is on line 8.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — the server is probably already running.`);
    console.error(`  Open http://localhost:${PORT}, or stop the old one:`);
    console.error(`    pkill -f "node --env-file-if-exists=.env server.js"`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`Not allowed to bind port ${PORT}. Ports below 1024 need root — pick a higher one.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  if (!dataset) {
    console.log('WARNING: data/sailings.json not found. Run `node scrape.js` first.\n');
  } else {
    console.log(`${dataset.sailings.length} sailings loaded, scraped ${dataset.scrapedAt}`);
  }
  console.log(selections.ok ? `Ratings: ${SELECTIONS_FILE}` : `Ratings unavailable: ${selections.reason}`);
  console.log(auth.on ? 'Login: on' : 'Login: off (this Mac only)');
  console.log(`Cruise search running at http://localhost:${PORT}`);
});
