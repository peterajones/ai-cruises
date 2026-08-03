/**
 * Canonicalizing. No AI here on purpose — every rule below is one you can state,
 * so it is written as a rule you can read and correct.
 */

/** Canonical destination -> the spellings sites actually use. */
const DESTINATIONS = {
  'caribbean-east': ['eastern caribbean', 'caribbean eastern', 'e caribbean', 'caribbean east'],
  'caribbean-west': ['western caribbean', 'caribbean western', 'w caribbean', 'caribbean west'],
  'caribbean-south': ['southern caribbean', 'caribbean southern', 's caribbean', 'caribbean south'],
  'caribbean': ['caribbean'],
  'bahamas': ['bahamas', 'bahamas florida'],
  'bermuda': ['bermuda'],
  'alaska': ['alaska', 'alaska inside passage', 'inside passage', 'alaska gulf'],
  'mexico': ['mexico', 'mexican riviera', 'baja mexico'],
  'hawaii': ['hawaii', 'hawaiian islands'],
  'mediterranean-west': ['western mediterranean', 'mediterranean western', 'w mediterranean'],
  'mediterranean-east': ['eastern mediterranean', 'mediterranean eastern', 'e mediterranean'],
  'mediterranean': ['mediterranean', 'med'],
  'northern-europe': ['northern europe', 'norway', 'norwegian fjords', 'baltic', 'scandinavia'],
  'british-isles': ['british isles', 'ireland britain'],
  'transatlantic': ['transatlantic', 'trans atlantic', 'repositioning transatlantic'],
  'panama-canal': ['panama canal', 'panama canal full transit'],
  'south-america': ['south america', 'south america antarctica'],
  'asia': ['asia', 'southeast asia', 'japan', 'far east'],
  'australia-nz': ['australia new zealand', 'australia', 'new zealand', 'south pacific'],
  'antarctica': ['antarctica'],
  'canada-new-england': ['canada new england', 'new england canada', 'canada'],
  'world': ['world cruise', 'grand voyage', 'world'],
};

/** Canonical cabin -> the names sites actually use. */
const CABINS = {
  interior: ['interior', 'inside', 'interior stateroom', 'inside stateroom', 'inside cabin'],
  oceanview: ['oceanview', 'ocean view', 'outside', 'outside stateroom', 'sea view', 'obstructed oceanview'],
  balcony: ['balcony', 'verandah', 'veranda', 'balcony stateroom', 'deluxe balcony'],
  suite: ['suite', 'mini suite', 'minisuite', 'junior suite', 'owners suite', 'penthouse'],
};

/** Fold punctuation and case away so 'Caribbean - Eastern' and 'E. Caribbean' compare. */
function key(raw) {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildLookup(groups) {
  const lookup = new Map();
  for (const [canonical, aliases] of Object.entries(groups)) {
    lookup.set(key(canonical), canonical);
    for (const alias of aliases) lookup.set(key(alias), canonical);
  }
  return lookup;
}

const DESTINATION_LOOKUP = buildLookup(DESTINATIONS);
const CABIN_LOOKUP = buildLookup(CABINS);

export function canonicalDestination(raw) {
  return DESTINATION_LOOKUP.get(key(raw)) ?? null;
}

export function canonicalCabin(raw) {
  return CABIN_LOOKUP.get(key(raw)) ?? null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function toIsoDate(raw) {
  const text = String(raw ?? '').trim();

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${pad(slash[1])}-${pad(slash[2])}`;

  const named = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    if (month >= 0) return `${named[3]}-${pad(month + 1)}-${pad(named[2])}`;
  }

  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** '$1,299' and '1299.00' both become 1299. Returns null if there is no number or multiple numbers. */
function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);

  // Find all formatted numbers (allowing commas as thousand separators)
  // Matches: 1,299 / 1299.00 / 1299 / 1,299.99 etc.
  const numbers = text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return null;

  // Reject if multiple numbers detected (e.g., price ranges)
  if (numbers.length > 1) return null;

  // Remove commas and convert to number
  const n = Number(numbers[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const REQUIRED = ['ship', 'departureDate', 'nights', 'price'];

/**
 * @param {object[]} rawRows - site-shaped rows straight from an adapter
 * @param {{source: string, line: string}} opts
 * @returns {{sailings: object[], unrecognised: {field: string, raw: string, count: number}[]}}
 */
export function normalizeAll(rawRows, { source, line }) {
  const sailings = [];
  const misses = new Map();

  // Key on a JSON pair rather than a delimited string: raw values contain spaces,
  // hyphens and commas, so any separator character you pick will eventually appear
  // inside one and split it in the wrong place.
  const miss = (field, raw) => {
    const k = JSON.stringify([field, raw]);
    misses.set(k, (misses.get(k) ?? 0) + 1);
  };

  for (const row of rawRows) {
    const sailing = {
      id: `${source}:${row.externalId}`,
      source,
      url: row.url ?? null,
      line: row.line ?? line,
      ship: row.ship ? String(row.ship).trim() : null,
      departurePort: row.departurePort ? String(row.departurePort).trim() : null,
      destination: null,
      departureDate: toIsoDate(row.departureDate),
      nights: toNumber(row.nights),
      cabin: null,
      price: toNumber(row.price),
      currency: row.currency ?? 'USD',
    };

    if (row.destination) {
      sailing.destination = canonicalDestination(row.destination);
      if (sailing.destination === null) miss('destination', String(row.destination));
    }

    if (row.cabin) {
      sailing.cabin = canonicalCabin(row.cabin);
      if (sailing.cabin === null) miss('cabin', String(row.cabin));
    }

    const missingField = REQUIRED.find((f) => sailing[f] === null || sailing[f] === '');
    if (missingField) {
      miss('row', `${sailing.id} missing ${missingField}`);
      continue;
    }

    sailings.push(sailing);
  }

  const unrecognised = [...misses.entries()].map(([k, count]) => {
    const [field, raw] = JSON.parse(k);
    return { field, raw, count };
  });

  return { sailings, unrecognised };
}
