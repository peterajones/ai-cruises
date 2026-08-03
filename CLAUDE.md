# ai-cruises

A cruise-listing scraper plus a natural-language search layer: describe the trip you
want in plain English (price, destination, dates, cabin type, amenities) instead of
filling in filter boxes.

## Architecture

```text
free text ──▶ [ MODEL ] ──▶ structured filter ──▶ [ PLAIN JS ] ──▶ results
```

The model only *translates*. The filtering is ordinary conditionals with no AI in them.

Reference implementation: `~/Desktop/shoe-store` (four files, zero npm deps,
`node server.js` → <http://localhost:3000>). Read it before designing anything here.

- `brain.js` — the only file that calls a model. Ollama, `format: 'json'`,
  temperature 0, system prompt that **enumerates every legal value** and says
  "never invent a value outside these lists; use null if unsure." That enumeration is
  what makes a 7B model reliable at this.
- `inventory.js` — `searchInventory(filter)`, ~8 lines of conditionals. No model.
- The UI prints the model's JSON filter on screen so the translation step is visible.

**Rule of thumb:** if you can specify the rule, write the rule. Reach for a model only
where the input space is unbounded, the criteria are genuinely fuzzy, or the output
must be natural language.

**Known gap to fix from the start:** in shoe-store, an unstockable request
("anything in lime green") maps to all-nulls, which matches *everything*. The schema
here needs an `unrecognised: []` field so the model can say "couldn't map that."

**Open design question, undecided:** which cruise attributes get *scraped* as
structured fields versus *inferred* by the model from listing prose. Amenities and
"vibe" descriptions are the interesting middle ground.

## Environment

- Node 22 — global `fetch`, so calling Ollama needs no dependencies.
- Ollama at `http://localhost:11434`, `qwen2.5-coder:latest` (7B) is the default.
  `qwen2.5-coder:1.5b-base` is a *base* model — not for chat or tool roles.
  `/api/chat` is POST-only; a 405 in the browser means it's running.
- No `ANTHROPIC_API_KEY` and no `ant` CLI — anything needing a scripted Claude call
  requires setup first.

## Working style

- Say what you're about to do, what Peter will run, and what success looks like —
  before doing it.
- Hand over the command and let him run it rather than reporting a summary of output.
- Build the smallest thing that *works* first; explore failure modes after.
- Never frame a failure as the intended outcome.
- Answer the question asked. Don't turn a question into a build session.
