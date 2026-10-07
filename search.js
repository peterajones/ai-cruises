/**
 * The search over the scraped sailings.
 *
 * NOTE: there is no AI in this file, on purpose. Filtering structured data is
 * something code does perfectly, cheaply and predictably — putting a model here
 * would make it slower, costlier and less reliable for zero gain.
 *
 * The model's job (see brain.js) is only to turn a sentence into the `filter`
 * object this function expects.
 */

/**
 * Plain, boring, deterministic filtering. A null field means "the shopper didn't
 * say", so it does not constrain the search.
 *
 * @param {object[]} sailings
 * @param {object} filter
 * @returns {object[]}
 */
export function searchSailings(sailings, filter = {}) {
  return sailings.filter((s) => {
    if (filter.line && s.line !== filter.line) return false;
    if (filter.ship && s.ship !== filter.ship) return false;
    if (filter.destination && s.destination !== filter.destination) return false;
    if (filter.departurePort && s.departurePort !== filter.departurePort) return false;
    // The cabin filter means "offers this cabin", and a price limit then applies to
    // that cabin's price.
    const counted = priceFor(s, filter.cabin);
    if (counted === null) return false;
    if (counted.notListed) {
      // Princess lists only its cheapest cabin, so the asked-for one costs at least
      // that: a maximum below it is known to be too low. A minimum can't rule it out.
      if (filter.maxPrice != null && s.price > filter.maxPrice) return false;
    } else {
      if (filter.minPrice != null && counted.price < filter.minPrice) return false;
      if (filter.maxPrice != null && counted.price > filter.maxPrice) return false;
    }
    // A sailing scraped before tripType existed (undefined) is a plain cruise. An
    // unrecognised one (null, reported by normalize.js) is neither: not ??, which
    // would turn it into a cruise.
    if (filter.tripType && (s.tripType === undefined ? 'cruise' : s.tripType) !== filter.tripType) return false;
    if (filter.nights != null && s.nights !== filter.nights) return false;
    if (filter.minNights != null && s.nights < filter.minNights) return false;
    if (filter.maxNights != null && s.nights > filter.maxNights) return false;
    if (filter.dateFrom && s.departureDate < filter.dateFrom) return false;
    if (filter.dateTo && s.departureDate > filter.dateTo) return false;
    return true;
  });
}

/**
 * Which price counts for this sailing when a cabin is asked for — and whether the
 * sailing qualifies at all. One rule, used by searchSailings and by the page.
 *
 * - No cabin asked for: the cheapest price, as it has always been.
 * - The sailing's cabinPrices table has the cabin: that cabin's price.
 * - A table without the cabin: null — the sailing does not offer it.
 * - cabinPrices null (only the cheapest cabin is listed — Princess): the listed
 *   cabin's price if that is the one asked for, otherwise "not listed".
 * - cabinPrices undefined (data scraped before the table existed): the old rule,
 *   matching on the cheapest cabin.
 *
 * @param {object} sailing
 * @param {string|null|undefined} cabin
 * @returns {{price: number|null, cabin: string|null, notListed?: true}|null}
 */
export function priceFor(sailing, cabin) {
  if (!cabin) return { price: sailing.price, cabin: sailing.cabin };

  const table = sailing.cabinPrices;
  if (table === undefined || table === null) {
    if (sailing.cabin === cabin) return { price: sailing.price, cabin };
    return table === null ? { price: null, cabin, notListed: true } : null;
  }

  return table[cabin] !== undefined ? { price: table[cabin], cabin } : null;
}

/**
 * Sailings that have not yet left. One departing today is kept — it is still
 * bookable on the morning of.
 *
 * Applied per request, not when the file loads: the server keeps a dataset until
 * the file changes, so a filter baked in at load would go stale as days pass.
 *
 * @param {object[]} sailings
 * @param {string} today - YYYY-MM-DD
 * @returns {object[]}
 */
export function upcoming(sailings, today) {
  return sailings.filter((s) => s.departureDate >= today);
}

/**
 * The calendar date in local time, as YYYY-MM-DD. Not toISOString(), which is UTC
 * and turns over to tomorrow during a North American evening.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A dollar amount preceded by "over" or "under" is a bounded, specifiable pattern —
// so it is written as a rule rather than left to the model. qwen 7B gets the
// direction wrong often enough to matter ("over $2,000" came back as maxPrice), and
// adding more instructions to the prompt made it LESS consistent, not more. The
// model still does the unbounded work: which fields a sentence mentions at all.
const MONEY = String.raw`(?:\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?|(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*(?:dollars|usd))`;
const OVER = new RegExp(
  String.raw`\b(?:over|above|more than|at least|starting at|no less than|minimum(?: of)?|upwards of)\s+` + MONEY,
  'i',
);
const UNDER = new RegExp(
  String.raw`\b(?:under|below|less than|no more than|up to|cheaper than|maximum(?: of)?|max)\s+` + MONEY,
  'i',
);

function amountFrom(match) {
  const digits = match[1] ?? match[3];
  const thousands = match[2] ?? match[4];
  if (!digits) return null;
  const n = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return thousands ? n * 1000 : n;
}

/**
 * Corrects the price direction the model chose, using the shopper's own wording.
 *
 * Requires a currency marker ($ or "dollars"), so "at least 5 nights" is left
 * alone — that is a nights constraint, not a price one.
 *
 * @param {string} question - the shopper's sentence, verbatim
 * @param {object} filter - the model's filter; not mutated
 * @returns {object} a corrected copy
 */
export function applyPriceDirection(question, filter = {}) {
  const out = { ...filter };
  const text = String(question ?? '');

  const over = OVER.exec(text);
  if (over) {
    const n = amountFrom(over);
    if (n !== null) {
      out.minPrice = n;
      if (out.maxPrice === n) out.maxPrice = null; // model put it in the wrong slot
    }
  }

  const under = UNDER.exec(text);
  if (under) {
    const n = amountFrom(under);
    if (n !== null) {
      out.maxPrice = n;
      if (out.minPrice === n) out.minPrice = null;
    }
  }

  return out;
}

/**
 * Flags a price filter that spans currencies — as a notice, not a refusal.
 *
 * The dataset mixes USD (Royal Caribbean, Celebrity) and CAD (Princess), and
 * `searchSailings` compares bare numbers, so "under $800" treats CAD 780 as if
 * it were USD 780 (really about USD 575). That is genuinely imprecise.
 *
 * It is not, however, worth blocking. This app is a launching pad for finding
 * interesting cruises, not a booking system: prices are indicative, and a
 * roughly-under-$800 list is useful while an error message is not. So the search
 * runs and the result carries a note. Being open about the fuzziness costs
 * nothing; withholding the answer costs the whole point of the feature.
 *
 * Returns null when there is nothing to say: no price filter, or every candidate
 * priced in one currency.
 *
 * @param {object[]} sailings - the candidates a price filter applies to
 * @param {object} filter
 * @returns {{currencies: string[], note: string}|null}
 */
export function currencyNote(sailings, filter = {}) {
  const constrainsPrice = filter.minPrice != null || filter.maxPrice != null;
  if (!constrainsPrice) return null;

  const currencies = [...new Set(sailings.map((s) => s.currency).filter(Boolean))].sort();
  if (currencies.length < 2) return null;

  const counts = currencies
    .map((c) => `${sailings.filter((s) => s.currency === c).length} in ${c}`)
    .join(', ');

  return {
    currencies,
    note: `Heads up: these are priced in ${currencies.join(' and ')} (${counts}), and the price filter compares the numbers as-is. Treat the cut-off as approximate.`,
  };
}

/** The keys that actually constrain a search. `unrecognised` is not one of them. */
const CONSTRAINTS = [
  'line', 'ship', 'destination', 'departurePort', 'cabin', 'tripType',
  'nights', 'minNights', 'maxNights', 'minPrice', 'maxPrice', 'dateFrom', 'dateTo',
];

/**
 * True when the filter constrains nothing at all.
 *
 * This is the guard against shoe-store's known failure: a request we cannot
 * express ("an adults-only ship with a Michelin restaurant") maps to all-nulls,
 * and an all-null filter matches EVERYTHING. Returning the whole dataset as if it
 * all qualified is a lie — worse than returning nothing, because it looks like an
 * answer. When the model recognised none of the request, say so instead.
 */
export function hasNoConstraints(filter = {}) {
  return !CONSTRAINTS.some((k) => filter[k] !== null && filter[k] !== undefined);
}

/**
 * Writes the "nothing matched" line.
 *
 * Three different empty states want different tones, and conflating them is how a
 * broken search gets mistaken for an empty ocean:
 *   - the filter matched nothing        -> light
 *   - the request named something we cannot express -> helpful, name it
 * (The third — the scraper parsing zero rows — is an operator-facing failure and
 * lives in scrape.js, where it stays blunt.)
 */
export function emptyMessage(filter = {}) {
  const unrecognised = (filter.unrecognised ?? []).filter(Boolean);

  if (unrecognised.length > 0) {
    const quoted = unrecognised.map((u) => `“${u}”`).join(', ');
    const understood = describeFilter(filter);
    return understood
      ? `Found nothing. I understood ${understood} — but nothing in these listings describes ${quoted}, so I ignored it.`
      : `Found nothing. Nothing in these listings describes ${quoted}.`;
  }

  const where = filter.destination ? titleCase(filter.destination) : null;
  return where
    ? `No ${where} cruises matched — you've had enough sun anyway.`
    : "Nothing matched that search — you've had enough sun anyway.";
}

/** Human-readable summary of the parts of a filter that were actually set. */
export function describeFilter(filter = {}) {
  const parts = [];
  if (filter.nights != null) parts.push(`${filter.nights} nights`);
  if (filter.minNights != null) parts.push(`${filter.minNights}+ nights`);
  if (filter.maxNights != null) parts.push(`up to ${filter.maxNights} nights`);
  if (filter.tripType === 'cruisetour') parts.push('cruisetours');
  if (filter.tripType === 'cruise') parts.push('cruises only');
  if (filter.cabin) parts.push(filter.cabin);
  if (filter.destination) parts.push(titleCase(filter.destination));
  if (filter.departurePort) parts.push(`from ${filter.departurePort}`);
  if (filter.ship) parts.push(filter.ship);
  if (filter.line) parts.push(filter.line);
  if (filter.maxPrice != null) parts.push(`under $${filter.maxPrice}`);
  if (filter.minPrice != null) parts.push(`over $${filter.minPrice}`);
  if (filter.dateFrom || filter.dateTo) {
    parts.push(`${filter.dateFrom ?? 'any'} to ${filter.dateTo ?? 'any'}`);
  }

  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function titleCase(slug) {
  return String(slug)
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
