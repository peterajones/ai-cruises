import * as royalCaribbean from './royal-caribbean.js';
import * as celebrity from './celebrity.js';
import * as princess from './princess.js';
import * as hollandAmerica from './holland-america.js';

// Royal Caribbean, Celebrity and Holland America read a JSON API; Princess parses
// the rendered results page, because its API cannot produce a dated price. Each
// adapter is a standalone file on purpose — when one site changes shape, the
// others keep running.
export const ADAPTERS = [royalCaribbean, celebrity, princess, hollandAmerica];

/**
 * @param {string[]} names - empty means all
 * @returns {typeof ADAPTERS}
 */
export function adaptersFor(names) {
  if (names.length === 0) return ADAPTERS;

  return names.map((wanted) => {
    const adapter = ADAPTERS.find((a) => a.name === wanted);
    if (!adapter) {
      throw new Error(
        `Unknown site "${wanted}". Known sites: ${ADAPTERS.map((a) => a.name).join(', ')}`,
      );
    }
    return adapter;
  });
}
