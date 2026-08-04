import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EmptyResultError } from './errors.js';

/**
 * Zero rows is a failure, not an empty ocean. Without this, a changed selector
 * silently overwrites good data with an empty array.
 */
export function assertNonEmpty(rows, context) {
  if (!Array.isArray(rows) || rows.length === 0) throw new EmptyResultError(context);
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
  await writeFile(join(dataDir, 'runs', `${stamp}.json`), json, 'utf8');

  return target;
}
