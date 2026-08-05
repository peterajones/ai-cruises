/**
 * Zero-dependency HTTP server for the cruise search.
 *
 *   node server.js   ->   http://localhost:3030
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
  currencyNote,
} from './search.js';

const PORT = 3030;
const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname;
const DATA_FILE = new URL('./data/sailings.json', import.meta.url).pathname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
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
  // `ship` is not in the scraper's derived enumeration, but the model needs it
  // to answer "on the Icon of the Seas". Derive it here from the same data so
  // it still cannot drift.
  parsed.values.ship = [...new Set(parsed.sailings.map((s) => s.ship))].sort();

  if (loadedMtime !== 0) {
    console.log(`data/sailings.json changed — reloaded ${parsed.sailings.length} sailings`);
  }
  loadedMtime = mtime;
  dataset = parsed;
  return dataset;
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
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }

    // What the page needs on load: the facets, and the whole dataset to render.
    if (req.method === 'GET' && req.url === '/api/dataset') {
      dataset = await loadDataset();
      if (!dataset) {
        return json(res, 503, {
          error: 'No data yet. Run `node scrape.js` first, then reload this page.',
        });
      }
      return json(res, 200, {
        scrapedAt: dataset.scrapedAt,
        values: dataset.values,
        ships: dataset.ships,
        sailings: dataset.sailings,
      });
    }

    if (req.method === 'POST' && req.url === '/api/search') {
      dataset = await loadDataset();
      if (!dataset) {
        return json(res, 503, { error: 'No data yet. Run `node scrape.js` first.' });
      }

      let body = '';
      for await (const chunk of req) body += chunk;
      const { q } = JSON.parse(body || '{}');

      if (!q || !q.trim()) return json(res, 400, { error: 'Ask for something.' });

      const started = Date.now();
      const { filter: modelFilter, raw, error } = await understand(
        q,
        dataset.values,
        dateRange(dataset.sailings),
      );

      if (error) return json(res, 502, { error, raw });

      // Deterministic correction of a rule the model gets wrong (see search.js).
      const filter = applyPriceDirection(q, modelFilter);

      // A filter that constrains nothing would match every sailing. If the model
      // also reported things it could not express, that "match everything" is a
      // lie dressed as an answer — return nothing and say why instead.
      const understoodNothing = hasNoConstraints(filter);

      const results = understoodNothing ? [] : searchSailings(dataset.sailings, filter);

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
        : searchSailings(dataset.sailings, { ...filter, minPrice: null, maxPrice: null });
      const currency = currencyNote(candidates, filter);

      return json(res, 200, {
        filter,
        results,
        understood: describeFilter(filter),
        understoodNothing,
        message: results.length === 0 ? emptyMessage(filter) : null,
        notice: currency?.note ?? null,
        tookMs: Date.now() - started,
      });
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
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

dataset = await loadDataset();

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

server.listen(PORT, () => {
  if (!dataset) {
    console.log('WARNING: data/sailings.json not found. Run `node scrape.js` first.\n');
  } else {
    console.log(`${dataset.sailings.length} sailings loaded, scraped ${dataset.scrapedAt}`);
  }
  console.log(`Cruise search running at http://localhost:${PORT}`);
});
