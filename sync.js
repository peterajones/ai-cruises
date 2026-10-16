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

export async function pullRatings({ config, store, fetchImpl, now = () => new Date().toISOString(), force = false }) {
  if (!store?.ok) throw new Error(store?.reason ?? 'Ratings are unavailable on this Mac.');
  const { selections } = await call(config, '/api/sync/selections', { fetchImpl });
  const mine = store.all().length;
  if (!force && mine > 0) {
    if (store.copiedAt() === null) {
      throw new Error(`This Mac has ${mine} saved cruises that were never copied from the server — nothing changed. Send them first with npm run push-ratings, or pull anyway with npm run pull-ratings -- --force.`);
    }
    if (selections.length === 0) {
      throw new Error(`The server has no saved cruises but this Mac has ${mine} — nothing changed. If the server lost its data, send yours with npm run push-ratings -- --force; to empty this Mac, npm run pull-ratings -- --force.`);
    }
  }
  return { copied: store.replaceAll(selections, { copiedAt: now() }) };
}

export async function pushRatings({ config, store, force = false, fetchImpl }) {
  if (!store?.ok) throw new Error(store?.reason ?? 'Ratings are unavailable on this Mac.');
  const body = gzipSync(Buffer.from(JSON.stringify({ selections: store.all() })));
  return call(config, `/api/sync/selections${force ? '?force=1' : ''}`, { method: 'PUT', body, headers: GZIP_JSON, fetchImpl });
}
