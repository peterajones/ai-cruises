/**
 * Cruise port -> the airport you would fly to. No AI: a known place name found inside
 * the port text, longest match winning — the same approach as findDestination in
 * normalize.js. A port the table does not know is null, and the scrape reports it.
 */

/** IATA code -> [display name, ...names that appear in port text]. */
const AIRPORTS = {
  YYZ: ['Toronto', 'toronto'],
  YVR: ['Vancouver', 'vancouver'],
  SEA: ['Seattle', 'seattle'],
  // Whittier and Seward are Anchorage's cruise ports.
  ANC: ['Anchorage', 'anchorage', 'whittier', 'seward'],
  FAI: ['Fairbanks', 'fairbanks'],
  FLL: ['Fort Lauderdale', 'fort lauderdale', 'ft lauderdale'],
  MIA: ['Miami', 'miami'],
  MCO: ['Orlando', 'orlando', 'port canaveral'],
  LAX: ['Los Angeles', 'los angeles'],
  SFO: ['San Francisco', 'san francisco'],
  SAN: ['San Diego', 'san diego'],
  HNL: ['Honolulu', 'honolulu'],
  SJU: ['San Juan', 'san juan'],
  BGI: ['Barbados', 'barbados'],
  JFK: ['New York', 'new york'],
  BOS: ['Boston', 'boston'],
  YUL: ['Montreal', 'montreal'],
  YQB: ['Quebec City', 'quebec city'],
  KEF: ['Reykjavik', 'reykjavik'],
  LHR: ['London', 'london', 'southampton'],
  AMS: ['Amsterdam', 'amsterdam', 'rotterdam'],
  CPH: ['Copenhagen', 'copenhagen'],
  HAM: ['Hamburg', 'hamburg'],
  HEL: ['Helsinki', 'helsinki'],
  BCN: ['Barcelona', 'barcelona'],
  FCO: ['Rome', 'rome', 'civitavecchia'],
  VCE: ['Venice', 'venice'],
  TRS: ['Trieste', 'trieste'],
  // Ravenna's nearest airport with real service is Bologna.
  BLQ: ['Bologna', 'bologna', 'ravenna'],
  ATH: ['Athens', 'athens', 'piraeus'],
  HND: ['Tokyo', 'tokyo', 'yokohama'],
  SIN: ['Singapore', 'singapore'],
  BKK: ['Bangkok', 'bangkok', 'laem chabang'],
  SYD: ['Sydney', 'sydney'],
  BNE: ['Brisbane', 'brisbane'],
  PER: ['Perth', 'perth', 'fremantle'],
  MEL: ['Melbourne', 'melbourne'],
  ADL: ['Adelaide', 'adelaide'],
  AKL: ['Auckland', 'auckland'],
  IST: ['Istanbul', 'istanbul'],
  LIS: ['Lisbon', 'lisbon'],
  BGO: ['Bergen', 'bergen'],
  ARN: ['Stockholm', 'stockholm'],
  BFS: ['Belfast', 'belfast'],
  OSL: ['Oslo', 'oslo'],
  TOS: ['Tromso', 'tromso'],
  HKG: ['Hong Kong', 'hong kong'],
  // Benoa is Bali's cruise port.
  DPS: ['Bali', 'bali', 'benoa'],
  // Fuerte Amador is Panama City's cruise pier.
  PTY: ['Panama City', 'panama city', 'fuerte amador'],
  // Deliberately no "san antonio": the Chilean port would match San Antonio, Texas.
  SCL: ['Santiago', 'santiago'],
  EZE: ['Buenos Aires', 'buenos aires'],
};

// Accents folded first, so "Reykjavík" and "Tromsø" match "reykjavik" and "tromso" — without
// this they lost the letter entirely ("reykjav k").
const key = (raw) => String(raw ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/ß/g, 'ss')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ALIASES = Object.entries(AIRPORTS).flatMap(([code, [, ...names]]) =>
  names.map((name) => [key(name), code]));

/**
 * @param {string|null} portText
 * @returns {string|null} IATA code
 */
export function airportFor(portText) {
  const haystack = key(portText);
  if (!haystack) return null;
  let best = null;
  let bestLength = 0;
  for (const [alias, code] of ALIASES) {
    if (alias.length <= bestLength) continue;
    if (new RegExp(`(^|\\s)${alias}($|\\s)`).test(haystack)) {
      best = code;
      bestLength = alias.length;
    }
  }
  return best;
}

/** @returns {string|null} a short city name for an airport code */
export function airportName(code) {
  return AIRPORTS[code]?.[0] ?? null;
}
