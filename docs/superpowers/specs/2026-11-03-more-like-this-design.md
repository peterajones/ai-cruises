# More like this — design

**Date:** 2026-11-03
**Status:** approved 2026-11-03

## Purpose

Peter has just found an interesting cruise and wants to see others like it. "Like it" means
similar ports at a similar price, on any line, leaving around the same time. This is a
launching pad, as the rest of the app is: an approximate answer with a caveat beats no answer.

It replaces the follow-up noted in the My cruises spec, which started from cruises rated
highly. This one starts from any cruise, rated or not.

## Peter's decisions

| Decision | Choice |
|---|---|
| Starting point | One cruise, just discovered; it needs no rating |
| What "similar" means | Ports and price, then cruise length, which counts less than both |
| Which lines | Any line |
| Date | Within two weeks either side of the cruise's departure |
| When nothing is very close | Always show the closest few rather than only strong matches |
| Where matches appear | They replace the results as normal full cards, under a banner, and ✕ brings the previous results back (layout A) |

## The rule

No model, no new route, no new dependency: `moreLikeThis(sailing, sailings)` is a pure function
in `search.js`, which the page already imports and which already holds the sailings it needs
(`state.all`, departed ones removed). A click costs nothing and works without an API key.

**Candidates:** every other sailing with at least one stop that departs within 14 days either
side, inclusive. The date decides who is in the running and plays no part in the order.

**Score**, higher is closer:

```text
0.6 × ports + 0.3 × (1 − price gap) + 0.1 × (1 − length gap)
```

- **ports:** shared stops ÷ all stops in either cruise (Jaccard).
- **price gap:** |difference| ÷ the source's price, capped at 1. Uses each sailing's cheapest
  price (`price`), whatever cabin was searched for.
- **length gap:** |difference in nights| ÷ the source's nights, capped at 1.

**Order:** score, then closest date, then `id`, so the same click always gives the same order.
**Show the top 12**, fewer if fewer exist. Nothing forces another line into the list: Oasis of
the Seas' stops are Nassau and Royal Caribbean's private island, so its closest 12 are all Royal
Caribbean, and that is the honest answer.

**Stops** are `ports` with names tidied for comparing only: lower case, accents folded,
parentheses and text after the first comma removed, "Scenic Sailing:" / "Scenic cruising" /
"Cruising" prefixes removed, and a trailing "National Park" removed. So "Juneau, Alaska" matches
"Juneau", and "Glacier Bay National Park (Scenic Cruising), Alaska" matches "Scenic Sailing:
Glacier Bay". The departure and end ports are removed as well, because lines disagree about
listing them (Princess's `ports` start with Vancouver; Holland America's do not). Cards go on
showing each line's own wording.

**Currency:** CAD is multiplied by a fixed 0.72 to compare with USD, for ranking only. Prices
display as listed. The rate is a rough constant, not a live one, which is enough for a launching
pad. When the 12 matches and the source are not all in one currency, the banner says the price
comparison is approximate.

## The page

- **The link:** a "More like this" control on each card in the main page's grid, including the
  My cruises chip. Not on a "No longer listed" card or one with no stops (46 of 4,255 sailings):
  those have nothing to compare.
- **The banner**, above the cards: "More like Discovery Princess · May 6, 2027", then the
  itinerary, the price, "closest first, within 2 weeks of its date", the currency note when it
  applies, and "✕ Back to results". If no other sailing qualifies, the banner stays and a line
  below it says so.
- **The cards** are the usual ones: stars, Viewed, ✈ Flights, View ↗. Each also says how many
  stops it shares, "Shares 4 of its 5 stops" or "Shares no stops". Anything rated or viewed can
  appear, marked as usual.
- **✕ Back to results** restores exactly what was there: the search, its filters, its sort and
  the scroll position.

## Builder's calls, so they can be checked

- **Filters and sort do not apply to the matches.** Facets, the sort and the search's cabin price
  are set aside while the banner shows, because the list is already ordered and is only 12 long;
  headline prices show the cheapest cabin. Using a filter, a year chip or the search box leaves
  More like this and applies to the previous results or the new search.
- **Clicking "More like this" on a match** moves to that cruise's matches. ✕ still returns to the
  original results, not to the previous match list.
- **Weights 0.6 / 0.3 / 0.1, and 12 matches,** were chosen by trying them on real data
  (2026-11-03): Discovery Princess's first match is Holland America's Westerdam, sharing all 5 of its
  stops, with Star Princess third; Coral Princess, which matched nothing under strict cut-offs, gets
  12 matches from 4 lines. In a sample of 209 sailings, 5 had no shared stop among their 12 and 105
  had another line among them, before Holland America's ports came back. They are constants, easily
  changed.
- **Browser Back** is not handled: ✕ is the way back.

## Out of scope

- The `/mine` table.
- Learning from ratings, or ratings changing the order.
- A live exchange rate.
- Any scraping or data change.

## Testing

- `moreLikeThis` unit tests with inline sailings: the 14-day edge on both sides, the source left
  out, sailings with no stops left out, name tidying across lines, departure and end ports not
  counted, ports outweighing price outweighing length, the CAD conversion, the order being
  repeatable, and fewer than 12 candidates.
- A page check for the banner and ✕ restoring the previous state, at ~800×600 and ~390×844 as
  well as the Studio Display. No inline scripts (`test/pages.test.js`).
- Run on Peter's four rated cruises and read the results.
