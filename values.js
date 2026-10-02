/**
 * Derives the enumeration brain.js puts in its prompt.
 *
 * Never hand-write this list. If it drifts from what is actually in
 * data/sailings.json, the model confidently emits a value that matches nothing
 * and the search returns empty with no error anywhere.
 */

function uniqueSortedStrings(values) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ''))].sort();
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter((v) => typeof v === 'number' && Number.isFinite(v)))]
    .sort((a, b) => a - b);
}

/**
 * @param {object[]} sailings
 * @returns {{line: string[], destination: string[], cabin: string[],
 *            departurePort: string[], nights: number[], tripType: string[]}}
 */
export function deriveValues(sailings) {
  return {
    line: uniqueSortedStrings(sailings.map((s) => s.line)),
    destination: uniqueSortedStrings(sailings.map((s) => s.destination)),
    cabin: uniqueSortedStrings(sailings.map((s) => s.cabin)),
    departurePort: uniqueSortedStrings(sailings.map((s) => s.departurePort)),
    nights: uniqueSortedNumbers(sailings.map((s) => s.nights)),
    // A sailing scraped before tripType existed is a plain cruise; an unrecognised
    // one (null) is left out, like any other null.
    tripType: uniqueSortedStrings(sailings.map((s) => (s.tripType === undefined ? 'cruise' : s.tripType))),
  };
}
