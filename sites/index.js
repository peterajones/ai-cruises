import * as royalCaribbean from './royal-caribbean.js';

// Only royal-caribbean is registered. Princess was attempted and abandoned:
// its API splits data across endpoints and carries no departure date
// anywhere, so every row would be dropped by the required-field rule.
// Reworking it is separate future work.
export const ADAPTERS = [royalCaribbean];

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
