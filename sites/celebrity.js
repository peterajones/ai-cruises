/**
 * Celebrity Cruises adapter. Knows about celebritycruises.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 *
 * This is deliberately a full copy of sites/royal-caribbean.js rather than a
 * shared parser with per-site config. Celebrity is a Royal Caribbean Group brand
 * on the same commerce platform, so the payloads are near-identical TODAY — but
 * the whole point of the adapter seam is that when one site changes its GraphQL
 * shape, the other keeps running. Sharing the parser would trade that away for
 * ~200 lines.
 *
 * The one thing a naive copy gets wrong is SITE_ORIGIN: image paths and booking
 * links are site-relative, so running Royal Caribbean's parser over Celebrity's
 * payload produces Celebrity images hosted at royalcaribbean.com.
 */

import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

export const name = 'celebrity';
export const line = 'Celebrity Cruises';

const SITE_ORIGIN = 'https://www.celebritycruises.com';

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
    const itinerary = it.name ?? null;
    // Image paths are site-relative; absolutise so a UI can use them directly.
    const imagePath = it.media?.images?.[0]?.path;
    const image = imagePath ? `${SITE_ORIGIN}${imagePath}` : null;
    // Ports actually visited, in order, minus embarkation/disembarkation.
    const ports = [
      ...new Set(
        (it.days ?? [])
          .flatMap((d) => d.ports ?? [])
          .filter((p) => p.activity !== 'EMBARK' && p.activity !== 'DEBARK')
          .map((p) => p.port?.name)
          // "Cruising" is how RC labels a sea day; it is not a port of call.
          .filter((n) => n && n !== 'Cruising'),
      ),
    ];

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
        itinerary,
        image,
        ports,
      });
    }
  }

  return rows;
}

/** Strip tags, decode the entities that actually appear, collapse whitespace. */
function toPlainText(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&') // last, so &amp;#39; decodes correctly
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two sources, tried in order of quality.
 *
 * Celebrity's ship pages carry NO introCopy block — verified against a real
 * capture — so in practice every description here comes from og:description,
 * about 145 characters. The introCopy branch is kept because the sites share a
 * platform and Celebrity may grow one; it costs one regex and would otherwise be
 * the better source. An empty return means both failed, and scrape.js treats
 * that as a failure rather than caching it.
 *
 * @param {string} html - a ship page
 * @returns {{line: string, description: string, source: string|null}}
 */
export function parseShip(html) {
  // Preferred: the "WHAT TO KNOW BEFORE YOU GO" tagline's following paragraph —
  // 100-600 characters of real prose about the ship.
  const intro = html.match(
    /<span[^>]*class="[^"]*\bintroCopy\b[^"]*"[^>]*>[\s\S]*?<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/i,
  );
  const introText = toPlainText(intro?.[1]);
  if (introText.length >= 80) {
    return { line, description: introText, source: 'introCopy' };
  }

  // Floor: the social/SEO description. Always present, ~140 characters.
  const meta = html.match(
    /<meta[^>]*(?:property="og:description"|name="description")[^>]*content="([^"]*)"/i,
  );
  const metaText = toPlainText(meta?.[1]);
  if (metaText.length > 0) {
    return { line, description: metaText, source: 'meta' };
  }

  return { line, description: '', source: null };
}

const SEARCH_URL = 'https://www.celebritycruises.com/cruises';

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
