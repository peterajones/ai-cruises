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
