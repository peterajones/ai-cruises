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
