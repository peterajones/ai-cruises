/**
 * Royal Caribbean adapter. Knows about royalcaribbean.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 */

import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

export const name = 'royal-caribbean';
export const line = 'Royal Caribbean';

const SITE_ORIGIN = 'https://www.royalcaribbean.com';

/**
 * @param {string} payload - raw JSON text captured from the cruises/graph search response
 * @returns {object[]} RawSailing rows, one per priced sailing
 */
export function parseListing(payload) {
  const data = JSON.parse(payload);
  const cruises = data?.data?.cruiseSearch?.results?.cruises;
  if (!cruises) return [];

  const rows = [];

  for (const c of cruises) {
    const it = c.masterSailing.itinerary;
    const ship = it.ship.name;
    const departurePort = it.departurePort.name;
    const destination = it.destination.name;
    const nights = it.sailingNights;

    for (const s of c.sailings) {
      const priced = (s.stateroomClassPricing ?? []).filter((p) => p.price != null);
      if (priced.length === 0) continue;

      const cheapest = priced.reduce((min, p) => (p.price.value < min.price.value ? p : min));

      rows.push({
        externalId: String(s.id),
        url: `${SITE_ORIGIN}${s.bookingLink}`,
        ship,
        departurePort,
        destination,
        departureDate: s.sailDate,
        nights,
        cabin: cheapest.stateroomClass.id,
        price: cheapest.price.value,
        currency: cheapest.price.currency.code,
      });
    }
  }

  return rows;
}

/**
 * @param {string} html - a ship page
 * @returns {{line: string, description: string}}
 */
export function parseShip(html) {
  // The "WHAT TO KNOW BEFORE YOU GO" section on a ship page carries a short
  // <span class="introCopy"> tagline followed by the real prose description
  // in the very next <p>. Grab that paragraph.
  const block = html.match(/<span class="introCopy">.*?<\/h2>\s*<p>([\s\S]*?)<\/p>/);

  const description = String(block?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return { line, description };
}

const SEARCH_URL = 'https://www.royalcaribbean.com/cruises';

/** Response URL substring shared by all four batched GraphQL operations on page load. */
const RESULTS_MATCH = 'cruises/graph';

/**
 * Content marker unique to the one GraphQL response (of four hitting the same
 * URL) that actually carries sailings. Recorded in NOTES.md, Task 8: size is
 * a decent heuristic but not a guarantee, so filter by content instead.
 */
const SAILINGS_MARKER = '"cruiseSearch"';

/**
 * @param {string} ship
 * @returns {string} absolute ship page URL
 */
export function shipUrl(ship) {
  const slug = String(ship)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${SITE_ORIGIN}/cruise-ships/${slug}`;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{limit: number}} options - `limit` is accepted for interface parity with the
 *   registry/CLI but currently unused: a single landing-page load already returns
 *   ~204 sailings, comfortably above what any caller needs, so no pagination is
 *   attempted. If pagination is ever required, the correct route is discovering
 *   the GraphQL request's parameters (page/offset/filter body) — not clicking
 *   blindly at the DOM of a site fronted by Akamai.
 * @returns {Promise<string[]>} raw JSON payload TEXT of the sailings-bearing responses only
 */
export async function fetchListingPages(page, { limit }) {
  const rawPayloads = [];

  const onResponse = async (response) => {
    if (!response.url().includes(RESULTS_MATCH)) return;
    if (!(response.headers()['content-type'] ?? '').includes('json')) return;
    try {
      rawPayloads.push(await response.text());
    } catch {
      // Body no longer available (page navigated on); a later load may produce another.
    }
  };
  page.on('response', onResponse);

  try {
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    await politeDelay();

    const wall = detectBotWall(await page.content());
    if (wall) throw new BotWallError(wall, SEARCH_URL);

    return rawPayloads.filter((p) => p.includes(SAILINGS_MARKER));
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} ship
 * @returns {Promise<string>} raw HTML
 */
export async function fetchShipPage(page, ship) {
  const url = shipUrl(ship);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await politeDelay();

  const html = await page.content();
  const wall = detectBotWall(html);
  if (wall) throw new BotWallError(wall, url);

  return html;
}
