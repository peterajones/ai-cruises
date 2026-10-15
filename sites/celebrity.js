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

/** Celebrity's media paths omit this; the assets 404 without it. */
const ASSET_ROOT = '/content/dam';

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
    // Image paths are site-relative AND lack the asset-root prefix that Royal
    // Caribbean's already carry: Celebrity returns "/celebrity/new-images/..."
    // where the file actually lives at "/content/dam/celebrity/new-images/...".
    // Verified against the live site — without the prefix every image 404s.
    const imagePath = it.media?.images?.[0]?.path;
    const image = imagePath
      ? `${SITE_ORIGIN}${imagePath.startsWith(ASSET_ROOT) ? '' : ASSET_ROOT}${imagePath}`
      : null;
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
    // Where the cruise ends: the port of the day the ship is left. Most return to where they began.
    const endPort = (it.days ?? []).flatMap((d) => d.ports ?? [])
      .find((p) => p.activity === 'DEBARK')?.port?.name ?? null;

    for (const s of c.sailings) {
      const priced = (s.stateroomClassPricing ?? []).filter((p) => p.price != null);
      if (priced.length === 0) continue;

      const cheapest = priced.reduce((min, p) => (p.price.value < min.price.value ? p : min));

      // Every priced class, by the site's label; normalize.js maps them to cabin types.
      const cabinPrices = Object.fromEntries(
        priced.map((p) => [p.stateroomClass.id, p.price.value]),
      );

      rows.push({
        externalId: String(s.id),
        url: `${SITE_ORIGIN}${s.bookingLink}`,
        ship,
        departurePort,
        endPort,
        destination,
        departureDate: s.sailDate,
        nights,
        cabin: cheapest.stateroomClass.id,
        price: cheapest.price.value,
        currency: cheapest.price.currency.code,
        cabinPrices,
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

/** URL substring shared by every GraphQL operation the page sends as it loads. */
const RESULTS_MATCH = 'cruises/graph';

/** The operation whose answer carries sailings; the page sends it as it loads. */
const SEARCH_OPERATION = 'CruisesSearchResults';

/**
 * Cruises per replayed request — enough for the whole catalogue at once (638 cruises:
 * 10 MB, ~5 s, 2026-10-15). Not smaller pages: on Royal Caribbean, the same platform, the
 * order shifts between requests, and paging by `skip` returned 67 cruises twice and missed
 * 67 others. Paging stays only for a catalogue that outgrows this, and a repeated cruise
 * then fails the fetch.
 */
export const PAGE_SIZE = 3000;

/** A `total` that never arrives must not page for ever. */
const MAX_PAGES = 20;

/** Headers the browser sets for itself; fetch() refuses or ignores them on a replay. */
const BROWSER_HEADERS = /^(:|sec-|user-agent$|accept-encoding$|content-length$|origin$|priority$|referer$|cookie$|host$|connection$)/;

export function replayHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !BROWSER_HEADERS.test(k)));
}

/**
 * One replay of the page's search from inside the page (same-origin, the site's own
 * cookies). HTTP 403, or HTML carrying a block's signature, is a bot wall; anything else
 * that isn't a search answer is an ordinary failure, and fails the line loudly.
 */
async function replay(page, captured, pagination) {
  const body = JSON.stringify({ ...captured.body, variables: { ...captured.body.variables, pagination } });
  const { status, text } = await page.evaluate(async (path, headers, b) => {
    const res = await fetch(path, { method: 'POST', headers, body: b });
    return { status: res.status, text: await res.text() };
  }, captured.path, captured.headers, body);

  if (status === 403) throw new BotWallError('HTTP 403', captured.path);
  const trimmed = String(text ?? '').trimStart();
  if (!trimmed.startsWith('{')) {
    // detectBotWall calls any short body a block; here a short body is just a bad answer.
    const reason = detectBotWall(text);
    if (reason && !reason.startsWith('response too small')) throw new BotWallError(reason, captured.path);
    throw new Error(`Celebrity search answered HTTP ${status} with no JSON: ${trimmed.slice(0, 80) || '(empty)'}`);
  }
  if (status >= 400) throw new Error(`Celebrity search answered HTTP ${status}: ${trimmed.slice(0, 80)}`);
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new Error(`Celebrity search answered invalid JSON: ${trimmed.slice(0, 80)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Celebrity search answered GraphQL errors: ${JSON.stringify(json.errors).slice(0, 120)}`);
  }
  const results = json.data?.cruiseSearch?.results;
  if (!Array.isArray(results?.cruises)) {
    throw new Error(`Celebrity search answer has no results.cruises (skip ${pagination.skip})`);
  }
  return { text: trimmed, results };
}




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
 * The whole ocean catalogue. The /cruises page asks for its first 10 cruises — the 114
 * sailings this adapter used to read, of ~1,900 — filtered to `voyageType:OCEAN`. The same
 * request takes a bigger `count` and a `skip`: capture the one the page sends (its filter
 * included, so river cruises stay out), then replay it for the whole catalogue at once.
 * No copy of the query lives here — if the site changes it, we replay theirs.
 *
 * @param {import('puppeteer').Page} page
 * @param {{limit?: number, onProgress?: (text: string) => void, pause?: () => Promise<void>}} options
 * @returns {Promise<string[]>} raw JSON answers, each a full cruiseSearch result
 */
export async function fetchListingPages(page, { limit = Infinity, onProgress = () => {}, pause = politeDelay } = {}) {
  let captured = null;
  const onRequest = (request) => {
    if (captured || request.method() !== 'POST' || !request.url().includes(RESULTS_MATCH)) return;
    const raw = request.postData() ?? '';
    if (!raw.includes(SEARCH_OPERATION)) return;
    try {
      captured = { path: new URL(request.url()).pathname, headers: replayHeaders(request.headers()), body: JSON.parse(raw) };
    } catch {
      // Not JSON: keep listening for the next one.
    }
  };

  page.on('request', onRequest);
  try {
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    const wall = detectBotWall(await page.content());
    if (wall) throw new BotWallError(wall, SEARCH_URL);
  } finally {
    page.off('request', onRequest);
  }
  if (!captured) {
    throw new Error('Celebrity: the search page sent no CruisesSearchResults request — the page or its API has changed');
  }

  // `limit` is in sailings; every cruise has at least one, so this many cruises is enough.
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(PAGE_SIZE, limit)) : PAGE_SIZE;
  const payloads = [];
  const seen = new Set();
  let sailings = 0;

  for (let n = 0; ; n += 1) {
    if (n === MAX_PAGES) {
      throw new Error(`Celebrity search ran to more than ${MAX_PAGES} pages without an end — stopping rather than guessing`);
    }
    await pause();
    const skip = n * count;
    const { text, results } = await replay(page, captured, { count, skip });
    if (results.cruises.length === 0) break;
    for (const cruise of results.cruises) {
      if (seen.has(cruise.id)) {
        throw new Error(`Celebrity search pages overlapped (cruise ${cruise.id} came back twice), so others were missed — stopping rather than keeping a partial catalogue`);
      }
      seen.add(cruise.id);
    }
    payloads.push(text);

    const total = Number.isFinite(results.total) ? results.total : null;
    onProgress(total === null ? `page ${n + 1}` : `page ${n + 1}/${Math.ceil(total / count)}`);
    sailings += parseListing(text).length;
    if (sailings >= limit) break;
    if (total !== null && skip + count >= total) break;
  }
  return payloads;
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
