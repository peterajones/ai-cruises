/**
 * Canonicalizing. No AI here on purpose — every rule below is one you can state,
 * so it is written as a rule you can read and correct.
 */

/** Canonical destination -> the spellings sites actually use. */
const DESTINATIONS = {
  'caribbean-east': ['eastern caribbean', 'caribbean eastern', 'e caribbean', 'caribbean east'],
  'caribbean-west': ['western caribbean', 'caribbean western', 'w caribbean', 'caribbean west'],
  'caribbean-south': ['southern caribbean', 'caribbean southern', 's caribbean', 'caribbean south'],
  'caribbean': ['caribbean', 'turks caicos', 'turks and caicos', 'grand turk'],
  'bahamas': ['bahamas', 'bahamas florida'],
  'bermuda': ['bermuda'],
  'alaska': ['alaska', 'alaska inside passage', 'inside passage', 'alaska gulf'],
  'mexico': ['mexico', 'mexican riviera', 'baja mexico', 'baja peninsula', 'sea of cortez'],
  // US/Canada west-coast sailings. Princess names these "Pacific Coastal" and
  // "Pacific Wine Country"; no other line in the dataset sails them.
  // "West Coast Getaway" is kept whole: a bare "west coast" would also match an
  // Australian or Tasmanian itinerary.
  'pacific-coast': ['pacific coastal', 'pacific coast', 'pacific wine country', 'california coast',
    'west coast getaway'],
  // Princess's "Pacific Crossing" runs between Honolulu and British Columbia; a
  // Hawaii shopper wants it. Keyed on the port, since a crossing could run elsewhere.
  'hawaii': ['hawaii', 'hawaiian islands', 'honolulu'],
  'mediterranean-west': ['western mediterranean', 'mediterranean western', 'w mediterranean'],
  'mediterranean-east': ['eastern mediterranean', 'mediterranean eastern', 'e mediterranean'],
  'mediterranean': ['mediterranean', 'med'],
  'northern-europe': ['northern europe', 'norway', 'norwegian fjords', 'baltic', 'scandinavia',
    'northern lights'],
  // Celebrity labels every European sailing "Europe" — Greek isles and Norwegian
  // fjords alike. Keep the source's granularity rather than inferring a sea from
  // the ports: guessing "mediterranean" would be right for some and wrong for the
  // rest, and a wrong label is worse than a coarse one.
  // Coarse on purpose: Spain touches both the Atlantic and the Mediterranean, so
  // "Spanish Passage" cannot be resolved to a specific sea without guessing.
  // "European Capitals" is coarse for the same reason — its ports happen to be North
  // Sea ones, but the title names no sea.
  'europe': ['europe', 'spain', 'spanish', 'spanish passage', 'portugal', 'european capitals'],
  'british-isles': ['british isles', 'ireland britain', 'irish counties', 'scottish shores'],
  // "Moroccan Passage" sails Rome to Fort Lauderdale via Morocco and Tenerife. Princess
  // uses "Passage" for repositioning voyages; the title never says "transatlantic".
  'transatlantic': ['transatlantic', 'trans atlantic', 'repositioning transatlantic', 'moroccan passage'],
  'panama-canal': ['panama canal', 'panama canal full transit'],
  'south-america': ['south america', 'south america antarctica', 'brazil', 'brazilian', 'cape horn',
    'patagonia'],
  // Princess names no region on its cards — only ports — so the adapter derives a
  // country and these map it to a region. The list grows as new ports appear; the
  // `unrecognised` output of a scrape is the to-do list. Countries are added only
  // once seen in real data, never pre-emptively.
  'asia': ['asia', 'southeast asia', 'japan', 'far east', 'vietnam', 'malaysia',
    'singapore', 'thailand', 'south korea', 'taiwan', 'china', 'hong kong', 'hokkaido'],
  // Princess titles its Australian sailings by coast or state, never "Australia".
  'australia-nz': ['australia new zealand', 'australia', 'new zealand', 'south pacific', 'fiji',
    'tasmania', 'queensland', 'great barrier reef', 'hunter coast', 'sapphire coast', 'coral coast'],
  'antarctica': ['antarctica'],
  'canada-new-england': ['canada new england', 'new england canada', 'canada'],
  'world': ['world cruise', 'grand voyage', 'world'],
};

/** Canonical cabin -> the names sites actually use. */
const CABINS = {
  interior: ['interior', 'inside', 'interior stateroom', 'inside stateroom', 'inside cabin'],
  oceanview: ['oceanview', 'ocean view', 'outside', 'outside stateroom', 'sea view', 'obstructed oceanview'],
  // 'aqua' is Celebrity's AquaClass: a veranda stateroom sold as a spa tier. It
  // belongs with balcony because it HAS a balcony — excluding it from a balcony
  // search would be a visibly wrong answer. The spa distinction is not something
  // this dataset can express.
  // 'aqua' (Celebrity's AquaClass) and 'concierge' (Concierge Class) are both
  // veranda staterooms sold with extra service. They belong with balcony because
  // they HAVE balconies — excluding them from a balcony search would be a
  // visibly wrong answer, and the service tier is not something this dataset can
  // express. Note CONCIERGE is priced above BALCONY on every sailing captured,
  // so the cheapest-tier rule never selects it — it was found by enumerating all
  // tiers in the fixture, not by the unrecognised list, which only ever sees the
  // tier that wins.
  balcony: [
    'balcony', 'verandah', 'veranda', 'balcony stateroom', 'deluxe balcony',
    'aqua', 'aquaclass', 'concierge', 'concierge class',
  ],
  // Holland America names each suite tier; a Vista Suite is its largest verandah
  // category, sold as a suite.
  suite: [
    'suite', 'mini suite', 'minisuite', 'junior suite', 'owners suite', 'penthouse', 'deluxe',
    'vista suite', 'neptune suite', 'pinnacle suite', 'signature suite',
  ],
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

/**
 * Finds a known destination inside a longer phrase.
 *
 * Royal Caribbean and Celebrity hand over a clean label ("Bahamas"). Princess
 * names no region at all — only a title like "9-Day Eastern Caribbean With St.
 * Thomas". Deriving the region from port countries gets this wrong in the most
 * misleading way: a Caribbean cruise departing Fort Lauderdale reads as "Florida",
 * which is where it leaves from, not where it goes.
 *
 * Longest alias wins, so "eastern caribbean" beats a bare "caribbean" in the same
 * title. Returns null when nothing matches — never a guess.
 *
 * @param {string} phrase
 * @returns {string|null}
 */
export function findDestination(phrase) {
  const haystack = key(phrase);
  if (!haystack) return null;

  let best = null;
  let bestLength = 0;

  for (const [alias, canonical] of DESTINATION_LOOKUP) {
    if (alias.length <= bestLength) continue;
    // Word-boundary match, so "asia" does not fire inside "Australasia".
    const re = new RegExp(`(^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`);
    if (re.test(haystack)) {
      best = canonical;
      bestLength = alias.length;
    }
  }

  return best;
}

export function canonicalDestination(raw) {
  return DESTINATION_LOOKUP.get(key(raw)) ?? null;
}

export function canonicalCabin(raw) {
  return CABIN_LOOKUP.get(key(raw)) ?? null;
}

/**
 * A site's per-cabin prices ({ BALCONY: 1028.16, … }) as cabin types. Two labels
 * that are one type (Celebrity's Balcony and Concierge) keep the cheaper price. An
 * adapter that supplies no table gets null: only the cheapest cabin is listed.
 *
 * @param {object|undefined|null} raw
 * @param {(field: string, raw: string) => void} miss
 * @returns {object|null}
 */
function canonicalCabinPrices(raw, miss) {
  if (raw === undefined || raw === null) return null;
  const table = {};
  for (const [label, value] of Object.entries(raw)) {
    const price = toNumber(value);
    if (price === null) continue;
    const cabin = canonicalCabin(label);
    if (cabin === null) {
      miss('cabin', String(label));
      continue;
    }
    if (table[cabin] === undefined || price < table[cabin]) table[cabin] = price;
  }
  return table;
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

/** A cruisetour is a cruise plus land days sold as one package (Holland America). */
const TRIP_TYPES = ['cruise', 'cruisetour'];

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
      cabinPrices: null,
      currency: row.currency ?? 'USD',
      // Adapters that sell only plain cruises never set this, so absent means cruise.
      tripType: row.tripType ?? 'cruise',
      // Presentation-only fields. Never required, never canonicalized, never
      // filtered on — they exist so a UI can render a card without a second fetch.
      itinerary: row.itinerary ?? null,
      image: row.image ?? null,
      ports: Array.isArray(row.ports) ? row.ports : [],
    };

    if (row.destination) {
      // Exact label first (Royal Caribbean, Celebrity); then look inside the
      // phrase (Princess, whose only region signal is the itinerary title).
      sailing.destination =
        canonicalDestination(row.destination) ?? findDestination(row.destination);
      if (sailing.destination === null) miss('destination', String(row.destination));
    }

    if (row.cabin) {
      sailing.cabin = canonicalCabin(row.cabin);
      if (sailing.cabin === null) miss('cabin', String(row.cabin));
    }

    sailing.cabinPrices = canonicalCabinPrices(row.cabinPrices, miss);

    if (!TRIP_TYPES.includes(sailing.tripType)) {
      miss('tripType', String(sailing.tripType));
      sailing.tripType = null;
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
