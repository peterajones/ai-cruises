# ai-cruises

A cruise-listing scraper plus a natural-language search layer: describe the trip you
want in plain English (price, destination, dates, cabin type, amenities) instead of
filling in filter boxes.

## Architecture

A scraper that extracts and normalizes cruise listings from Royal Caribbean, structured as
fetch-then-parse stages:

```text
browser ──fetch──▶ HTML/JSON ──parse──▶ RawSailing[] ──normalize──▶ Sailing[] ──persist──▶ JSON
```

Each stage knows only its own inputs and outputs. Adapters live in `sites/`.

- `sites/royal-caribbean.js` — fetch and parse the Royal Caribbean endpoint, return raw rows.
- `normalize.js` — canonicalize destination/cabin labels via `DESTINATIONS` and `CABINS` mappings,
  enforce required fields, flag unrecognised values.
- `values.js` — derive the enumeration of every unique destination/cabin/port/nights/price
  across the dataset.
- `persist.js` — write atomically to `data/sailings.json` (write to temp file, move on success).

**Rule of thumb:** if you can specify the rule, write the rule. Field validation, normalization,
and enumeration are conditionals, not model calls. The model belongs only in the search layer
(that piece is not in this scraper).

## Running it

```bash
npm test                                  # unit tests, no network
node scrape.js --limit 5 --dry-run        # smoke test, writes nothing
node scrape.js                            # real run, writes data/sailings.json
```

Fixtures in `test/fixtures/` are real captured payloads. When a site changes shape,
re-capture with `node tools/capture-fixture.js` and update the golden first-row files.
Synthetic test data belongs inline in test files, never in `test/fixtures/`.

A scrape that yields zero parsed rows is treated as a failure and exits with code 1,
leaving the previous `data/sailings.json` untouched — a broken selector cannot overwrite
a good dataset.

## Environment

- Node 22 — global `fetch`, so calling Ollama needs no dependencies.
- Ollama at `http://localhost:11434`, `qwen2.5-coder:latest` (7B) is the default.
  `qwen2.5-coder:1.5b-base` is a *base* model — not for chat or tool roles.
  `/api/chat` is POST-only; a 405 in the browser means it's running.
- No `ANTHROPIC_API_KEY` and no `ant` CLI — anything needing a scripted Claude call
  requires setup first.

## Status

**Royal Caribbean:** Complete and working. A single GraphQL endpoint returns all 8 required
fields (ship, port, destination, date, nights, cabin, price, id) on one object, one response.
Real run yields 200 sailings: 6 ships (Wonder of the Seas, Allure of the Seas, Icon of the Seas,
Jewel of the Seas, Freedom of the Seas, Oasis of the Seas), all with ship descriptions,
destinations [Bahamas, Caribbean], cabins [balcony, interior, oceanview], nights [3,4,5,6,7,9],
departure ports [Fort Lauderdale, Miami], prices $334.08–$2226.29.

**Princess Cruises:** Attempted and abandoned. The sailings catalog and pricing data are two
separate API endpoints. The catalog carries no departure date or price, only itinerary templates
and ship×date combinations. Every parsed row from the catalog alone fails the required-field rule
and yields zero sailings. Fixing this would require either reverse-engineering the pricing
endpoint's POST body (unknown, no query string), or parsing the rendered search page instead of
the API — both out of scope for a network-only scraper. The site is still under `sites/` as a
reference for the rejection logic.

## Working style

- Say what you're about to do, what Peter will run, and what success looks like —
  before doing it.
- Hand over the command and let him run it rather than reporting a summary of output.
- Build the smallest thing that *works* first; explore failure modes after.
- Never frame a failure as the intended outcome.
- Answer the question asked. Don't turn a question into a build session.
