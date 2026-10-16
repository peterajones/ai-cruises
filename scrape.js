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
import { assertNonEmpty, carryOver, dedupeById, loadExisting, mergeShips, writeResult } from './persist.js';
import { ADAPTERS, adaptersFor } from './sites/index.js';
import { createReporter } from './progress.js';
import { dataDir } from './paths.js';

const DATA_DIR = dataDir();

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

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The local date, YYYY-MM-DD. */
const localToday = () => new Date().toLocaleDateString('en-CA');

const addDaysIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Every line's horizon: departing after today, up to 365 days ahead (spec 2026-10-15) — a
 * rolling 12 months, moving forward with each scrape. One rule for all six lines, applied
 * to each line's fresh sailings and to any carried over from the previous run.
 */
export function withinNextYear(sailings, today) {
  const until = addDaysIso(today, 365);
  const kept = [];
  const beyond = {};
  for (const s of sailings) {
    if (s.departureDate > today && s.departureDate <= until) kept.push(s);
    else beyond[s.source] = (beyond[s.source] ?? 0) + 1;
  }
  return { kept, beyond };
}

/**
 * The zero-row guard runs before the window, so a line whose every sailing falls outside it
 * (a changed date format, say) would pass, then write nothing and replace its good data.
 * Throwing makes it a failed line instead, which keeps its previous sailings.
 */
export function requireSomeInYear(name, before, after) {
  if (before > 0 && after === 0) {
    throw new Error(`${name}: all ${before} sailings fall outside the next 12 months — a changed date format?`);
  }
}

/**
 * The end-of-run to-do list, by what fixes each kind. A skipped sailing is not a missing
 * alias: Princess drops a few unpriced sailings every run, and "add aliases to
 * normalize.js" above them sent you looking for a fix that doesn't exist.
 */
export function describeMisses(misses) {
  const lines = [];
  const group = (items, heading, format) => {
    if (items.length === 0) return;
    lines.push(heading(items.length), ...items.map(format));
  };
  const value = (m) => `  ${m.field}: "${m.raw}" (${m.count}x)`;
  group(misses.filter((m) => m.field === 'row'),
    (n) => `${plural(n, 'sailing', 'sailings')} skipped — a required field is missing (Princess drops a few unpriced ones every run):`,
    (m) => `  ${m.raw}`);
  group(misses.filter((m) => m.field !== 'row' && m.field !== 'airport'),
    (n) => `${plural(n, 'unrecognised value', 'unrecognised values')} — add ${n === 1 ? 'an alias' : 'aliases'} to normalize.js:`,
    value);
  group(misses.filter((m) => m.field === 'airport'),
    (n) => `${plural(n, 'port', 'ports')} with no airport — add ${n === 1 ? 'it' : 'them'} to airports.js:`,
    value);
  return lines;
}

/**
 * The lines whose sailings come from the previous run: those that failed, and — with
 * --site — those not scraped at all. Before the second, `--site royal-caribbean` wrote a
 * file holding Royal Caribbean alone and every other line's sailings were gone.
 * A line no longer registered is in neither list, so its sailings drop out.
 */
export function linesToKeep(registered, ran, failed) {
  return registered.flatMap((name) => {
    if (failed.has(name)) return [{ name, reason: 'failed' }];
    if (!ran.includes(name)) return [{ name, reason: 'not scraped' }];
    return [];
  });
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
  const report = createReporter();
  const today = localToday();

  const browser = await launch();
  const allSailings = [];
  const failedSources = new Set();
  const allMisses = [];
  const freshShips = {};
  const failures = [];

  for (const adapter of adapters) {
    const page = await newPage(browser);
    report.start(adapter.name);
    let payloads = [];
    try {
      payloads = await adapter.fetchListingPages(page, {
        limit: flags.limit,
        onProgress: (text) => report.progress(adapter.name, text),
        log: report.log,
      });
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
        report.log(`${adapter.name}: dropped ${duplicates} duplicate sailings`);
      }

      const { kept: inYear, beyond } = withinNextYear(unique, today);
      // Not under --limit: a handful of sailings may all be far off, and that's no failure.
      if (!Number.isFinite(flags.limit)) requireSomeInYear(adapter.name, unique.length, inYear.length);
      if (beyond[adapter.name]) {
        report.log(`${adapter.name}: left out ${beyond[adapter.name]} sailings outside the next 12 months`);
      }
      const sailings = inYear.slice(0, flags.limit);
      if (sailings.length < inYear.length) {
        report.log(
          `${adapter.name}: --limit ${flags.limit} truncated ${inYear.length} sailings to ${sailings.length}`,
        );
      }
      allSailings.push(...sailings);
      allMisses.push(...unrecognised);
      report.end(adapter.name, `${sailings.length} sailings`);
    } catch (err) {
      report.clear();
      // Both of these abort without writing, and both save the page that caused
      // them — but they need different fixes, so they must not read alike.
      if (err instanceof BotWallError) {
        // An adapter that opens its own tabs (Princess) closes them; the error carries the page.
        const path = await snapshotFailure(err.pageHtml ?? await page.content(), `${adapter.name}-wall`);
        console.error(`${adapter.name}: BOT WALL — ${err.reason}.`);
        console.error(`  This is a block, not a parse failure. Body saved to ${path}`);
      } else if (err instanceof ConflictingDuplicateError) {
        console.error(`${adapter.name}: ${err.message}`);
        console.error(`  Keeping ${adapter.name}'s sailings from the previous run.`);
      } else if (err instanceof EmptyResultError) {
        // Save what the parser received: adapters may load pages in their own tabs, so the shared page could be blank.
        const path = await snapshotFailure(payloads.length > 0 ? payloads.join('\n\n') : await page.content(), `${adapter.name}-empty`);
        console.error(`${adapter.name}: parsed 0 sailings.`);
        console.error(`  Selectors probably broke. Page saved to ${path}`);
        console.error(`  Keeping ${adapter.name}'s sailings from the previous run.`);
      } else {
        console.error(`${adapter.name}: ${err.message}`);
      }
      failures.push(`${adapter.name} listing: ${err.message}`);
      failedSources.add(adapter.name);
    } finally {
      await page.close();
    }
  }

  const existing = (await loadExisting(DATA_DIR)) ?? { ships: {} };

  // A line that failed keeps its sailings from the previous run (the exit code still says
  // it failed), rather than vanishing from the file until its next good scrape; so does a
  // line this run didn't ask for (--site).
  const kept = linesToKeep(ADAPTERS.map((a) => a.name), adapters.map((a) => a.name), failedSources);
  const carried = carryOver(existing.sailings, new Set(kept.map((k) => k.name)));
  // A previous run may predate the window, or have been scraped months ago: trim it too.
  const { kept: carriedInYear } = withinNextYear(carried, today);
  allSailings.push(...carriedInYear);
  for (const { name, reason } of kept) {
    const n = carriedInYear.filter((s) => s.source === name).length;
    if (reason === 'failed') console.error(`${name}: kept ${n} sailings from the previous run`);
    else console.log(`${name}: not scraped — kept ${n} sailings from the previous run`);
  }

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

  const adapterFor = (ship) => adapters.find((a) => allSailings.some((s) => s.ship === ship && s.source === a.name));
  // An adapter that declares it has no ship descriptions is not asked for them.
  // Fetching anyway only produces a "failure" that is really a known gap.
  const toFetch = needed.filter((ship) => adapterFor(ship) && adapterFor(ship).shipDescriptions !== false);
  if (toFetch.length > 0) report.start('ships');

  for (const [i, ship] of toFetch.entries()) {
    const adapter = adapterFor(ship);
    report.progress('ships', `${i + 1}/${toFetch.length} ${ship}`);
    const page = await newPage(browser);
    try {
      const html = await adapter.fetchShipPage(page, ship);
      const parsed = adapter.parseShip(html);

      // An empty description is a parse failure wearing a success costume. Record
      // it and do NOT cache it, so the next run retries instead of inheriting it.
      if (!parsed.description) {
        report.clear();
        console.error(`ship "${ship}": fetched ${html.length} bytes but parsed no description`);
        failures.push(`ship "${ship}": no description parsed`);
      } else {
        freshShips[ship] = { ...parsed, url: adapter.shipUrl(ship) };
      }
    } catch (err) {
      // A failed ship page must not kill the run — the sailing is still good.
      report.clear();
      console.error(`ship "${ship}": ${err.message}`);
      failures.push(`ship "${ship}": ${err.message}`);
    } finally {
      await page.close();
    }
  }

  if (toFetch.length > 0) report.end('ships', `${plural(Object.keys(freshShips).length, 'description', 'descriptions')} fetched`);
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

  const misses = describeMisses(result.unrecognised);
  if (misses.length > 0) console.log(`\n${misses.join('\n')}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  }
  console.log('');
  report.done();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
