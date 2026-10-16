// npm run upload-data | pull-ratings | push-ratings  [-- --force]
import { join } from 'node:path';
import { dataDir } from '../paths.js';
import { openSelections, DEFAULT_FILE } from '../selections.js';
import { syncConfig, uploadSailings, pullRatings, pushRatings } from '../sync.js';

const [command] = process.argv.slice(2);
const force = process.argv.includes('--force');

try {
  const config = syncConfig();
  if (!config) throw new Error('Set SYNC_URL and SYNC_KEY in .env first.');
  if (command === 'upload') {
    const { stored, was } = await uploadSailings({ config, dataFile: join(dataDir(), 'sailings.json'), force });
    console.log(`Uploaded: the server now has ${stored} sailings (was ${was}).`);
  } else if (command === 'pull' || command === 'push') {
    const store = await openSelections(process.env.SELECTIONS_FILE || DEFAULT_FILE);
    if (command === 'pull') {
      const { copied } = await pullRatings({ config, store, force });
      console.log(`Copied ${copied} saved cruises from the server.`);
    } else {
      const { stored } = await pushRatings({ config, store, force });
      console.log(`Sent ${stored} saved cruises to the server.`);
    }
  } else {
    throw new Error('Use: node tools/sync.js upload | pull | push [--force]');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
