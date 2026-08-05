/**
 * Princess Cruises adapter. Knows about princess.com and nothing else.
 *
 * Unlike the Royal Caribbean and Celebrity adapters, this one parses the RENDERED
 * results page rather than a JSON API. That is not a preference — Princess's API
 * cannot produce a dated price. Its catalog carries dates without prices, its
 * pricing endpoint carries prices with no date field at all, and for ~9% of
 * itineraries one price maps to several sail dates with no way to tell which. The
 * rendered card carries both on one element, so the DOM is the only source that
 * answers the question.
 *
 * Prices are CANADIAN DOLLARS. `?currency=USD` and the /en-us/ path were both
 * tried and ignored — the site geolocates. Store CAD honestly; converting would
 * bake in a rate that goes stale and invent precision the source never gave.
 */

export const name = 'princess';
export const line = 'Princess Cruises';

const SITE_ORIGIN = 'https://www.princess.com';

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "Wed, Dec 09, 2026" -> "2026-12-09". Null on anything else. */
function toIsoDate(input) {
  const m = String(input ?? '').match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${String(m[2]).padStart(2, '0')}`;
}

/** Strip tags, decode the entities that appear, collapse whitespace. */
function text(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First capture group of a pattern, as plain text, or ''. */
function grab(html, pattern) {
  return text((html.match(pattern) ?? [])[1]);
}

function absolute(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : `${SITE_ORIGIN}${url}`;
}

/**
 * @param {string} html - a rendered results page
 * @returns {object[]} RawSailing rows, one per dated departure card
 */
export function parseListing(html) {
  const doc = String(html ?? '');
  const rows = [];

  // Each result is one .coveo-result-card. Not all of them are sailings: the page
  // mixes in promo tiles ("Up to 40% Off", "FREE 3rd & 4th Guests") that carry no
  // departure. Cards without a .date-ship element are skipped, which is why a
  // 20-card page yields 15 rows.
  const cards = doc.split(/<div[^>]*class="[^"]*\bcoveo-result-card\b/).slice(1);

  for (const card of cards) {
    const dateShip = grab(card, /class="[^"]*\bdate-ship\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!dateShip.includes(' on ')) continue;

    const [rawDate, rawShip] = dateShip.split(' on ');
    const departureDate = toIsoDate(rawDate);
    const ship = rawShip?.trim();
    if (!departureDate || !ship) continue;

    // The card shows a struck-through "Was" price above the real "Now" price:
    //   <div class="... striked-price ..."><span>Was</span><span class="amount">$<s>2362</s></span></div>
    //   <div class="price align-center"><span>Now</span><span class="amount">$1,142</span></div>
    // Anchoring on the literal "Now" label is what keeps this from silently
    // reporting the higher pre-discount fare on every single sailing.
    const nowAmount = grab(card, /Now<\/span>\s*<span[^>]*class="[^"]*\bamount\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const price = Number(nowAmount.replace(/[^0-9.]/g, '')) || null;

    // The title is the anchor's text, NOT the whole .details-header div — the div
    // also contains the "Save" wishlist button, which otherwise appends to it.
    const itinerary = grab(card, /class="[^"]*\bdetails-header\b[^"]*"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const nights = Number((itinerary.match(/(\d+)\s*-?\s*Day/i) ?? [])[1]) || null;

    // "Roundtrip from Singapore" is a bare text node that comes BEFORE a nested
    // promo div. Capturing to the closing </div> would swallow "Up to 40% Off".
    const portLine = grab(card, /class="[^"]*\bdetails-ports\b[^"]*"[^>]*>([^<]*)/);
    const departurePort = (portLine.split(/\bfrom\b/i)[1] ?? '').trim() || null;

    // Each port is its own <a class="port-link">. Splitting a flattened text blob
    // does not work: collapsing whitespace destroys the boundaries between them.
    const ports = [
      ...new Set(
        [...card.matchAll(/class="[^"]*\bport-link\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
          .map((m) => text(m[1]))
          .filter((p) => p && !/^scenic cruising/i.test(p)),
      ),
    ];

    // The detail link carries a real per-departure identifier: ?voyageCode=M634.
    // Preferred over synthesising one from ship+date, because it is the site's own.
    const href = (card.match(/href="([^"]*itinerary-details[^"]*)"/) ?? [])[1];
    const voyage = (href?.match(/voyageCode=([A-Z0-9]+)/i) ?? [])[1];
    const img = (card.match(/<img[^>]+src="([^"]+)"/) ?? [])[1];

    rows.push({
      externalId: voyage
        ? `${voyage}_${departureDate}`
        : `${ship}_${departureDate}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      url: absolute(href),
      ship,
      departurePort,
      destination: null, // set below from the ports, since the card names no region
      departureDate,
      nights,
      cabin: grab(card, />([^<]*?)\s*from\*/) || null,
      price,
      currency: 'CAD',
      itinerary: itinerary || null,
      image: absolute(img),
      ports,
    });
  }

  // Princess never names a region on the card — only ports. Use the country that
  // appears most often among the ports as the destination hint, and let
  // normalize.js decide whether it maps to anything. Taking the first or last port
  // would say "Singapore" for a Vietnam cruise that happens to round-trip there.
  for (const row of rows) {
    const counts = new Map();
    for (const port of row.ports) {
      if (!port.includes(',')) continue;
      const country = port.split(',').pop().trim();
      counts.set(country, (counts.get(country) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    row.destination = ranked.length > 0 ? ranked[0][0] : row.departurePort;
  }

  return rows;
}
