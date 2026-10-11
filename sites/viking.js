/**
 * Viking adapter (ocean cruises). Knows about vikingcruisescanada.com and nothing else.
 * Returns site-shaped rows — no canonicalizing here, that is normalize.js's job.
 *
 * The search page embeds its itineraries in a script; each itinerary's dated sailings
 * come from one Dates & Pricing request. See
 * docs/superpowers/specs/2026-10-11-viking-design.md.
 */

import { politeDelay, detectBotWall } from '../browser.js';
import { BotWallError } from '../errors.js';

export const name = 'viking';
export const line = 'Viking';

/** No usable ship pages investigated; scrape.js skips ship descriptions for this line. */
export const shipDescriptions = false;

const SITE_ORIGIN = 'https://www.vikingcruisescanada.com';
const SEARCH_URL = `${SITE_ORIGIN}/oceans/search-cruises/index.html`;
const MODEL_MARKER = 'window.app.superfac.viewModel';
const COMBINATION = 'River + Ocean Combinations';

/** The JSON object assigned after `marker = ` in a script, by brace matching. */
function embeddedObject(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && (depth -= 1) === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

/**
 * @param {string} html - the ocean search page
 * @returns {{promoCode: string|null, itineraries: object[]}}
 */
export function extractItineraries(html) {
  const model = embeddedObject(html, MODEL_MARKER);
  const value = model?.PageData?.Value;
  if (!value?.Results) return { promoCode: null, itineraries: [] };
  return {
    promoCode: value.CurrentPromoCode ?? null,
    itineraries: value.Results.filter((r) => !(r.Regions ?? []).includes(COMBINATION)),
  };
}
