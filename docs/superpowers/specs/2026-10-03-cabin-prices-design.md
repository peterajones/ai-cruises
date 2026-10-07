# Prices per cabin type — design

**Date:** 2026-10-03
**Status:** approved 2026-10-03

## Purpose

Make a cabin search mean what a person means by it. Today every sailing stores one cabin
and one price — its cheapest — so "a week in Alaska with a balcony" returns nothing: all
809 Alaska sailings store `interior`, and only 4 of 1,261 sailings store `balcony`. The
cabin filter has really been "the cheapest cabin is this type", not "this type is on offer".

After this change, asking for a cabin type finds sailings that **have** it, priced **for
that cabin**: "a balcony under $2,000" compares the balcony price. Prices stay orientative
(see CLAUDE.md, "What this is for"). Searches that mention no cabin behave exactly as now.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Shape | A per-sailing table, `cabinPrices`, alongside the existing cheapest `price`/`cabin` | One card per cabin type would multiply the cards by up to four. Keeping `price`/`cabin` means nothing that reads them breaks. |
| Cabin types | The four canonical types: interior, oceanview, balcony, suite | Already the vocabulary of `normalize.js`, the model's enum and the dropdown. |
| Princess | `cabinPrices: null` — "not listed"; shown in cabin searches with a note, whatever the price limit | Its results card shows only "Interior from $X"; per-cabin prices exist only in its pricing endpoint, which has no dates. Every Princess ship has balconies, so hiding Princess would hide real options. Peter's choice. |
| Where the rule lives | One function in `search.js`, used by the server **and** the page | The page today keeps its own copy of the filter logic. These rules are subtle enough that two copies would drift. `search.js` has no imports, and the page is already a module, so it can import the same file. |

## What each line provides (checked 2026-10-03 against the captured fixtures)

| Line | Source | Classes |
|---|---|---|
| Royal Caribbean | `sailings[].stateroomClassPricing[]` — `{ stateroomClass.id, price.value }`, `price: null` when unavailable | INTERIOR, OUTSIDE, BALCONY, DELUXE. 199 of 204 sailings have 3+ priced classes. |
| Celebrity | same structure | INTERIOR, OUTSIDE, BALCONY, CONCIERGE, AQUA, DELUXE. 115 of 119 have 3+. |
| Holland America | `price_<CUR>_<code>_<fare type>_d` keys; code names in `meta` | IN, OV, VN, LA, VS, NS, SS, PH. |
| Princess | rendered card: one "Now" price and "Interior from" | Cheapest only. |

## Design

### 1. The data — `cabinPrices`

- Every sailing gains `cabinPrices`: an object from canonical cabin type to that type's
  cheapest price, in the sailing's own currency — e.g.
  `{ interior: 959, oceanview: 999, balcony: 1449, suite: 2654 }`. A type with no price
  (sold out, or not on that ship) is absent.
- `cabinPrices: null` means **not listed**: only the cheapest cabin is known (Princess).
  This is deliberately different from a table that lacks `balcony`, which means *there is
  no balcony price*.
- Adapters supply a **raw** table, site labels to prices (`{ BALCONY: 1028.16, … }`), or
  omit it. `normalize.js` canonicalizes each label with the existing `CABINS` mapping,
  keeps the cheaper price when two labels share a type (Celebrity's Balcony and Concierge;
  Holland America's four suite names), and reports an unmappable label in `unrecognised`,
  as it does for `cabin` today. An adapter that omits the table gets `null`.
- `price` and `cabin` keep meaning the cheapest overall.
- Per adapter:
  - **Royal Caribbean, Celebrity:** every class whose `price` is not null, by
    `stateroomClass.id`.
  - **Holland America:** for each two-letter cabin code, the cheapest public fare in the
    sailing's chosen currency (the same currency `cheapestFare` picked), keyed by the
    code's `meta` label. Lanai stays unmapped and reported, as now.
  - **Princess:** omitted → `null`.

### 2. Search — `search.js`

One new exported function decides which price counts:

```js
/**
 * @returns {{price: number|null, cabin: string, notListed?: true} | null}
 *   null — the sailing does not offer this cabin: exclude it.
 */
export function priceFor(sailing, cabin)
```

| Situation | Result |
|---|---|
| `cabin` not given | `{ price: sailing.price, cabin: sailing.cabin }` — today's behaviour |
| `cabinPrices` has the cabin | `{ price: cabinPrices[cabin], cabin }` |
| `cabinPrices` is a table without the cabin | `null` — excluded |
| `cabinPrices` is `null` (Princess) | the asked-for cabin is the sailing's `cabin`: `{ price: sailing.price, cabin }`; otherwise `{ price: null, cabin, notListed: true }` — included. *(Corrected while planning: Princess does list its cheapest cabin, so that one is priced.)* |
| `cabinPrices` is `undefined` (data scraped before this change) | `sailing.cabin === cabin ? { price: sailing.price, cabin } : null` — today's rule |

`searchSailings` uses it for the cabin filter, and applies `minPrice`/`maxPrice` to the
returned `price`. A `notListed` result passes any price limit: its price for that cabin
is unknown, not known to be too high, and the card says so.

- `values.js` derives the `cabin` list from every key of every `cabinPrices` table, plus
  each sailing's `cabin` — so `balcony` becomes a choice the model and the dropdown offer.
- `brain.js`: no change. Its vocabulary already maps "balcony", "verandah", "inside".
- `currencyNote` is unchanged: it judges the candidates before the price limit.

### 3. The page — `public/index.html`

- `server.js` serves `/search.js` (as `text/javascript`); the page imports `priceFor` from
  it, so the Cabin dropdown, the price slider and "Cheapest first" use the same rule as
  search.
- The headline price on a card is `priceFor(sailing, chosenCabin)`, labelled with that
  cabin. `chosenCabin` is the Cabin dropdown's value when one is set, otherwise the
  search filter's `cabin` — the dropdown is the more recent, more specific choice. With no cabin chosen, it is
  the cheapest, as now.
- A card with a table shows a row of prices by cabin: *Inside $959 · Ocean view $999 ·
  Balcony $1,449 · Suite $2,654*.
- A `notListed` card shows *"Balcony price not listed · from $1,142 interior"* (with the
  chosen cabin's name).

## Testing and verification

Unit tests, test-first:

- `priceFor`: one test per row of the table in section 2, plus a price limit against a
  `notListed` result.
- `normalize`: labels canonicalized; the cheaper price kept when two labels share a type;
  an unmappable label reported; an omitted table becomes `null`.
- Each adapter against its captured fixture: Royal Caribbean and Celebrity leave out a
  null-priced class; Celebrity folds Concierge into balcony; Holland America folds the
  suites; Princess supplies none.
- `values`: `cabin` includes types found only in tables.

Live checks, because a green suite says nothing about whether the page and the data agree:

1. A headless-browser check on a temporary server: the page loads `/search.js`, and
   choosing Balcony in the dropdown shows the same sailings and prices as the search rule.
2. After a full scrape, "a week in Alaska with a balcony" returns Holland America and
   Celebrity sailings at balcony prices plus Princess sailings marked not listed, and "a
   balcony under $2,000" applies the balcony price.

## Order of work

Each step is its own commit.

1. `priceFor` in `search.js`, and `server.js` serving `/search.js`.
2. `cabinPrices` in `normalize.js` and `values.js`.
3. The adapters: Royal Caribbean, Celebrity, Holland America, Princess.
4. `searchSailings` uses `priceFor`.
5. The page.
6. Full scrape, live checks, `CLAUDE.md`.

## Out of scope

- Per-cabin prices for Princess (its dated prices exist only on the rendered card).
- Grouping a cruise's cruisetour packages onto one card.
- Any change to how the cheapest `price` is chosen.
