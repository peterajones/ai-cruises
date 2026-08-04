/**
 * Dev tool. Opens a URL, records the JSON responses the page fetches, and saves
 * one of them as a test fixture.
 *
 *   node tools/capture-fixture.js --url <url> --list
 *   node tools/capture-fixture.js --url <url> --match search --out test/fixtures/x.json
 *   node tools/capture-fixture.js --url <url> --html --out test/fixtures/x.html
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { launch, newPage, politeDelay } from '../browser.js';
import { detectBotWall } from '../browser.js';

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' },
    match: { type: 'string', default: '' },
    out: { type: 'string' },
    list: { type: 'boolean', default: false },
    html: { type: 'boolean', default: false },
    wait: { type: 'string', default: '8000' },
  },
});

if (!opts.url) {
  console.error('--url is required');
  process.exit(2);
}

const browser = await launch();
const page = await newPage(browser);
const captured = [];

page.on('response', async (response) => {
  const url = response.url();
  const type = response.headers()['content-type'] ?? '';
  if (!type.includes('json')) return;
  if (opts.match && !url.includes(opts.match)) return;
  try {
    const body = await response.text();
    captured.push({ url, bytes: body.length, body });
  } catch {
    // Response body already gone (redirect, or the page navigated away). Skip it.
  }
});

await page.goto(opts.url, { waitUntil: 'networkidle2', timeout: 60_000 });
await politeDelay(Number(opts.wait));

const html = await page.content();
const wall = detectBotWall(html);
if (wall) console.error(`WARNING: page looks like a bot wall (${wall})`);

captured.sort((a, b) => b.bytes - a.bytes);

if (opts.list || !opts.out) {
  console.log(`\n${captured.length} JSON responses, largest first:\n`);
  for (const c of captured.slice(0, 25)) {
    console.log(`${String(c.bytes).padStart(9)}  ${c.url.slice(0, 140)}`);
  }
  console.log('\nRe-run with --match <substring> --out <path> to save one.');
} else if (opts.html) {
  await writeFile(opts.out, html, 'utf8');
  console.log(`Saved ${html.length} bytes of HTML to ${opts.out}`);
} else if (captured.length === 0) {
  console.error('No JSON responses matched. Try --list, or --html if the page is server-rendered.');
  process.exitCode = 1;
} else {
  await writeFile(opts.out, captured[0].body, 'utf8');
  console.log(`Saved ${captured[0].bytes} bytes from ${captured[0].url} to ${opts.out}`);
}

await browser.close();
