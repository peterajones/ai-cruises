# TODO

_Single source of truth for unfinished work in this project. Tick an item when it is done; the review harness records it and removes the line._

## Next
- [x] Run `npm test` and `node scrape.js --limit 5 --dry-run` after the zod 3→4 and puppeteer bump, then fix anything that breaks. (from: review harness)
- [x] Fix Holland America prices: its API stopped honouring `fl` wildcards, so every sailing is dropped as unpriced (from: scrape dry run 2026-11-03)
- [x] Fail a line whose rows all get dropped in normalize, so it keeps its previous sailings instead of exiting 0 with none (from: scrape dry run 2026-11-03)
- [x] Add "Puget Sound" to airports.js (from: scrape dry run 2026-11-03)
- [x] Decide on an airport for "Skagway, Alaska, US", a Holland America end port on 32 sailings with no airport mapped (from: scrape dry run 2026-11-03)

## Later
- [ ] Add "More like this": suggest cruises similar to the ones rated highly (from: docs/superpowers/specs/2026-10-14-my-cruises-design.md)

## Undecided
