/**
 * Royal Caribbean adapter. Knows about royalcaribbean.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 */

export const name = 'royal-caribbean';
export const line = 'Royal Caribbean';

const SITE_ORIGIN = 'https://www.royalcaribbean.com';

/**
 * @param {string} payload - raw JSON text captured from the cruises/graph search response
 * @returns {object[]} RawSailing rows, one per priced sailing
 */
export function parseListing(payload) {
  const data = JSON.parse(payload);
  const cruises = data?.data?.cruiseSearch?.results?.cruises ?? [];

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
