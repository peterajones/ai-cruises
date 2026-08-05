#!/usr/bin/env node
/**
 * Collects sailings from every registered site and writes data/sailings.json.
 *
 *   node scrape.js [--limit N] [--site royal-caribbean] [--refresh-ships] [--dry-run]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, newPage } from './browser.js';
import { BotWallError, ConflictingDuplicateError, EmptyResultError } from './errors.js';
import { normalizeAll } from './normalize.js';
import { deriveValues } from './values.js';
import { assertNonEmpty, dedupeById, loadExisting, mergeShips, writeResult } from './persist.js';
import { adaptersFor } from './sites/index.js';

const DATA_DIR = new URL('./data/', import.meta.url).pathname;

export function parseFlags(argv) {
  // No cap by default. A fixed default silently shaped the production dataset:
  // 200 against a 204-row payload dropped four real sailings on every plain run,
  // and reported "200 sailings" as though that were what the site returned.
  const flags = { limit: Infinity, sites: [], refreshShips: false, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') flags.limit = Number(argv[i + 1]);
    else if (argv[i] === '--site') flags.sites.push(argv[i + 1]);
    else if (argv[i] === '--refresh-ships') flags.refreshShips = true;
    else if (argv[i] === '--dry-run') flags.dryRun = true;
  }

  return flags;
}

async function snapshotFailure(body, label) {
  await mkdir(join(DATA_DIR, 'debug'), { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const path = join(DATA_DIR, 'debug', `${label}-${stamp}.txt`);
  await writeFile(path, body, 'utf8');
  return path;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const adapters = adaptersFor(flags.sites);

  const browser = await launch();
  const allSailings = [];
  const allMisses = [];
  const freshShips = {};
  const failures = [];

  for (const adapter of adapters) {
    const page = await newPage(browser);
    try {
      const payloads = await adapter.fetchListingPages(page, { limit: flags.limit });
      const rows = payloads.flatMap((p) => adapter.parseListing(p));

      // Zero rows means something broke. Never let it become an empty file.
      assertNonEmpty(rows, `${adapter.name} listing`);

      const { sailings: normalized, unrecognised } = normalizeAll(rows, {
        source: adapter.name,
        line: adapter.line,
      });
      // Several GraphQL operations hit the same endpoint on one page load and
      // more than one can carry the same sailings. Dedupe before the limit, or
      // --limit N would spend its budget on repeats.
      const { sailings: unique, duplicates } = dedupeById(normalized);
      if (duplicates > 0) {
        console.log(`${adapter.name}: dropped ${duplicates} duplicate sailings`);
      }

      const sailings = unique.slice(0, flags.limit);
      if (sailings.length < unique.length) {
        console.log(
          `${adapter.name}: --limit ${flags.limit} truncated ${unique.length} sailings to ${sailings.length}`,
        );
      }
      allSailings.push(...sailings);
      allMisses.push(...unrecognised);
      console.log(`${adapter.name}: ${sailings.length} sailings`);
    } catch (err) {
      // Both of these abort without writing, and both save the page that caused
      // them — but they need different fixes, so they must not read alike.
      if (err instanceof BotWallError) {
        const path = await snapshotFailure(await page.content(), `${adapter.name}-wall`);
        console.error(`${adapter.name}: BOT WALL — ${err.reason}.`);
        console.error(`  This is a block, not a parse failure. Body saved to ${path}`);
      } else if (err instanceof ConflictingDuplicateError) {
        console.error(`${adapter.name}: ${err.message}`);
        console.error('  Not writing data/sailings.json — the previous run is preserved.');
      } else if (err instanceof EmptyResultError) {
        const path = await snapshotFailure(await page.content(), `${adapter.name}-empty`);
        console.error(`${adapter.name}: parsed 0 sailings.`);
        console.error(`  Selectors probably broke. Page saved to ${path}`);
        console.error('  Not writing data/sailings.json — the previous run is preserved.');
      } else {
        console.error(`${adapter.name}: ${err.message}`);
      }
      failures.push(`${adapter.name} listing: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  const existing = (await loadExisting(DATA_DIR)) ?? { ships: {} };

  // Drop cached entries that carry no description before anything reads them.
  // mergeShips lets `existing` win when not refreshing, so a previously-failed
  // entry would otherwise overwrite a good fresh one and never heal.
  const cachedShips = Object.fromEntries(
    Object.entries(existing.ships ?? {}).filter(([, entry]) => entry?.description),
  );

  const wantedShips = [...new Set(allSailings.map((s) => s.ship))];
  // Filter on the description, not on key presence. A cached entry with an empty
  // description is a previous failure, and keying on presence alone meant those
  // ships were never retried — the failure became permanent.
  const needed = flags.refreshShips
    ? wantedShips
    : wantedShips.filter((ship) => !cachedShips[ship]);

  for (const ship of needed) {
    const adapter = adapters.find((a) => allSailings.some((s) => s.ship === ship && s.source === a.name));
    if (!adapter) continue;

    const page = await newPage(browser);
    try {
      const html = await adapter.fetchShipPage(page, ship);
      const parsed = adapter.parseShip(html);

      // An empty description is a parse failure wearing a success costume. Record
      // it and do NOT cache it, so the next run retries instead of inheriting it.
      if (!parsed.description) {
        console.error(`ship "${ship}": fetched ${html.length} bytes but parsed no description`);
        failures.push(`ship "${ship}": no description parsed`);
      } else {
        freshShips[ship] = { ...parsed, url: adapter.shipUrl(ship) };
      }
    } catch (err) {
      // A failed ship page must not kill the run — the sailing is still good.
      console.error(`ship "${ship}": ${err.message}`);
      failures.push(`ship "${ship}": ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  const result = {
    scrapedAt: new Date().toISOString(),
    sailings: allSailings,
    ships: mergeShips(cachedShips, freshShips, { refresh: flags.refreshShips }),
    values: deriveValues(allSailings),
    unrecognised: allMisses,
  };

  if (flags.dryRun) {
    console.log(JSON.stringify({ ...result, sailings: result.sailings.slice(0, 3) }, null, 2));
    console.log(`\nDRY RUN — ${result.sailings.length} sailings, nothing written.`);
  } else {
    try {
      assertNonEmpty(result.sailings, 'the whole run');
      const path = await writeResult(DATA_DIR, result);
      console.log(`\nWrote ${result.sailings.length} sailings to ${path}`);
    } catch (err) {
      if (err instanceof EmptyResultError) {
        console.error('\nParsed 0 sailings across every site.');
        console.error('  Not writing data/sailings.json — the previous run is preserved.');
        failures.push(`whole run: ${err.message}`);
        process.exitCode = 1;
      } else {
        throw err;
      }
    }
  }

  if (result.unrecognised.length > 0) {
    console.log(`\n${result.unrecognised.length} unrecognised values — add aliases to normalize.js:`);
    for (const miss of result.unrecognised) {
      console.log(`  ${miss.field}: "${miss.raw}" (${miss.count}x)`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
