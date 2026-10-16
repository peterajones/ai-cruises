import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where sailings.json lives: DATA_DIR, or the app's data/ folder. A second copy for checks
 * points DATA_DIR at scratch, so neither its server nor its Refresh touches Peter's data.
 */
export function dataDir(env = process.env) {
  return env.DATA_DIR ? resolve(env.DATA_DIR) : fileURLToPath(new URL('./data/', import.meta.url));
}
