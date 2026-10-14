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
