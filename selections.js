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
import { dirname, join } from 'node:path';

export const DEFAULT_FILE = new URL('./data/selections.db', import.meta.url).pathname;

// tripType and cabinPrices keep a departed cruise's "Cruisetour" label and its place under a
// cabin filter (added 2026-10-15; older rows gain them at their next view or rating).
const SNAPSHOT_FIELDS = [
  'id', 'line', 'ship', 'itinerary', 'destination', 'departureDate', 'nights', 'price',
  'currency', 'cabin', 'url', 'image', 'departurePort', 'tripType', 'cabinPrices',
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
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;

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
    unview: db.prepare('UPDATE selections SET views = 0, first_viewed = NULL, last_viewed = NULL WHERE sailing_id = ?'),
    clear: db.prepare('DELETE FROM selections'),
    insert: db.prepare(`
      INSERT INTO selections (sailing_id, rating, first_viewed, last_viewed, views, rated_at, snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
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

    /**
     * Undoes the views (an accidental View ↗). A rated cruise keeps its rating; an unrated one
     * has nothing left to keep, and its row goes — the same rule as clearing a rating.
     */
    clearViews(id) {
      const existing = store.get(id);
      if (!existing) return null;
      if (existing.rating === null) {
        q.remove.run(id);
        return null;
      }
      q.unview.run(id);
      return store.get(id);
    },

    /** Forgets a cruise entirely: its rating, its views and its snapshot. */
    forget(id) {
      q.remove.run(id);
      return null;
    },

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
  const isUnview = method === 'POST' && path === '/api/selections/unview';
  const isForget = method === 'POST' && path === '/api/selections/forget';
  if (!isView && !isRate && !isUnview && !isForget) return { status: 404, body: { error: 'Not found' } };

  let input;
  try {
    input = JSON.parse(body || '{}');
  } catch {
    return bad('The request body is not JSON.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Send a JSON object.');
  if (typeof input.id !== 'string' || !input.id) return bad('Which sailing? Send { "id": "…" }.');

  // Undoing works on the row, listed or not: a departed cruise can still be tidied away.
  if (isUnview || isForget) {
    if (!store.get(input.id)) return { status: 404, body: { error: `Nothing saved for ${input.id}.` } };
    return { status: 200, body: { selection: isUnview ? store.clearViews(input.id) : store.forget(input.id) } };
  }

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

/** Beside the database it came from, so a scratch database's export stays in scratch. */
export function exportPath(dbFile = DEFAULT_FILE, day) {
  return join(dirname(dbFile), `selections-export-${day}.json`);
}

// npm run export-selections — a readable copy, for backups.
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--export')) {
  const file = process.env.SELECTIONS_FILE || DEFAULT_FILE;
  const store = await openSelections(file);
  if (!store.ok) {
    console.error(store.reason);
    process.exit(1);
  }
  const rows = store.all();
  const day = new Date().toLocaleDateString('en-CA');
  const out = exportPath(file, day);
  writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), selections: rows }, null, 2));
  console.log(`Wrote ${rows.length} selections to ${out}`);
}
