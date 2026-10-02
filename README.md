# ai-cruises

Describe the cruise you have in mind in plain English, and see the sailings that fit:

> *a week in Alaska with a balcony under $2,000*
> *a Denali land tour next summer*
> *something cheap out of Fort Lauderdale*

This is a place to get inspired: the ships, the routes, the places you'll visit. It is
not a booking site. Prices are approximate, shown in whatever currency the cruise line
publishes, and every card links to the line's own page for the real details.

## What's in it

Sailings from four cruise lines, gathered by a scraper that runs on your machine:

| Line | Source | Notes |
|---|---|---|
| Royal Caribbean | the site's search API | USD |
| Celebrity Cruises | the site's search API | USD |
| Princess Cruises | the rendered results page | CAD (the site geolocates) |
| Holland America | the site's search API | USD, Alaska only, cruises and cruisetours |

A *cruisetour* is a cruise plus land days (Denali, the Yukon) sold as one package. These
are marked on their cards, and you can ask for them ("Denali land tour") or leave them
out ("cruise only").

## How it works

```text
scrape:  browser ─fetch─▶ HTML/JSON ─parse─▶ raw rows ─normalize─▶ sailings ─persist─▶ data/sailings.json
search:  your sentence ─Claude─▶ a structured filter ─plain code─▶ matching sailings
```

- **The scraper uses no AI.** Each cruise line has its own adapter in `sites/`, and they
  share no code, so when one site changes, the others keep working. `normalize.js` maps
  every site's labels onto one vocabulary of destinations, cabins and trip types.
- **The model has one job:** turning your sentence into a filter. Claude Haiku is only
  allowed to choose values that exist in the scraped data, so it can't invent a
  destination. The filtering itself is ordinary code in `search.js`.
- Sailings that have already departed are hidden automatically.

## Running it

Requires **Node 22** or later and an [Anthropic API key](https://console.anthropic.com/)
for the search. A search costs a fraction of a cent.

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env   # gitignored

npm run scrape     # gather sailings into data/sailings.json (takes several minutes)
npm run serve      # then open http://localhost:3030
```

Other commands:

```bash
npm test                              # unit tests; no network
node scrape.js --limit 5 --dry-run    # quick smoke test that writes nothing
node scrape.js --site princess        # scrape one line only
```

A scrape that finds no sailings exits with code 1 and leaves the previous data file
untouched, so a broken site can't wipe out a good dataset. The server picks up a new
data file without a restart.

## Scraping politely

The scraper makes requests one at a time with a delay between them, takes a bounded
number of pages from each line, and stops if it meets a bot check rather than trying to get around
it. It's a personal project for browsing cruises, not a data service. Please keep it
that way if you run it.

## Project notes

`CLAUDE.md` has the working notes: each site's quirks and the reasons behind the design
decisions. Design specs and implementation plans are in `docs/superpowers/`.

## Licence

[MIT](LICENSE)
