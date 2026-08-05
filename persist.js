import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConflictingDuplicateError, EmptyResultError } from './errors.js';

/**
 * Zero rows is a failure, not an empty ocean. Without this, a changed selector
 * silently overwrites good data with an empty array.
 */
export function assertNonEmpty(rows, context) {
  if (!Array.isArray(rows) || rows.length === 0) throw new EmptyResultError(context);
}

/** Fields whose disagreement means two rows are not the same sailing. */
const IDENTITY_FIELDS = [
  'ship',
  'departureDate',
  'nights',
  'departurePort',
  'destination',
  'cabin',
  'price',
  'currency',
];

/**
 * Drops repeat sailings, keeping the first occurrence.
 *
 * A single page load fires several GraphQL operations at the same endpoint, and
 * more than one can carry the same sailings — Celebrity returns 118 rows twice,
 * so a naive flatMap reports 236. The duplicates are identical, so they cause no
 * visibly wrong result: they just silently double the count and would double
 * every page of a paginated UI.
 *
 * `id` is source-prefixed by normalizeAll, so this is safe across adapters: two
 * lines cannot collide even if they share an external id.
 *
 * THE GUARD: dropping a row is only safe while rows sharing an id are actually
 * the same sailing. That holds today — all 118 Celebrity repeats are identical
 * across every field, verified against a live capture — but it is an assumption
 * about someone else's data, not a fact we control. If a site ever issues two
 * genuinely different sailings under one id, silently keeping the first would
 * discard a real cruise and no count would look wrong. So disagreement throws.
 * Presentation-only fields (image, itinerary, ports, url) are excluded: a
 * different hero image is not a different sailing.
 *
 * @param {object[]} sailings
 * @returns {{sailings: object[], duplicates: number}}
 * @throws {ConflictingDuplicateError} when two rows share an id but differ
 */
export function dedupeById(sailings) {
  const byId = new Map();
  const unique = [];

  for (const sailing of sailings) {
    const first = byId.get(sailing.id);

    if (first === undefined) {
      byId.set(sailing.id, sailing);
      unique.push(sailing);
      continue;
    }

    const conflicts = IDENTITY_FIELDS.filter((field) => first[field] !== sailing[field]);
    if (conflicts.length > 0) {
      throw new ConflictingDuplicateError(sailing.id, conflicts, first, sailing);
    }
  }

  return { sailings: unique, duplicates: sailings.length - unique.length };
}

export async function loadExisting(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, 'sailings.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * A ship's blurb changes roughly never, so cached descriptions win unless
 * --refresh-ships was passed.
 */
export function mergeShips(existing = {}, fresh = {}, { refresh }) {
  return refresh ? { ...existing, ...fresh } : { ...fresh, ...existing };
}

/**
 * Temp file plus rename, so a crash mid-write never leaves half a file where a
 * good one used to be. Also drops a dated copy in runs/ for later price history.
 * @returns {Promise<string>} path of the file written
 */
export async function writeResult(dataDir, result) {
  await mkdir(join(dataDir, 'runs'), { recursive: true });

  const json = `${JSON.stringify(result, null, 2)}\n`;
  const target = join(dataDir, 'sailings.json');
  const temp = `${target}.tmp`;

  await writeFile(temp, json, 'utf8');
  await rename(temp, target);

  const stamp = result.scrapedAt.replace(/:/g, '-');
  const runTarget = join(dataDir, 'runs', `${stamp}.json`);
  const runTemp = `${runTarget}.tmp`;
  await writeFile(runTemp, json, 'utf8');
  await rename(runTemp, runTarget);

  return target;
}
