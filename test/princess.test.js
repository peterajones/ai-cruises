import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, parseShip, shipUrl, name, line, shipDescriptions } from '../sites/princess.js';
import { normalizeAll } from '../normalize.js';

const html = await readFile(new URL('./fixtures/princess-results.html', import.meta.url), 'utf8');

const golden = JSON.parse(
  await readFile(new URL('./fixtures/princess-first-row.json', import.meta.url), 'utf8'),
);

test('the first row matches the hand-checked golden row', () => {
  assert.deepEqual(parseListing(html)[0], golden);
});

test('the adapter identifies itself', () => {
  assert.equal(name, 'princess');
  assert.equal(line, 'Princess Cruises');
});

test('parses one row per DATED departure card', () => {
  // Verified against the fixture: splitting on .coveo-result-card yields 20 cards,
  // but only 15 carry a .date-ship element. The other 5 are promo tiles
  // ("Up to 40% Off", "FREE 3rd & 4th Guests") with no departure on them.
  assert.equal(parseListing(html).length, 15);
});

test('every row carries the fields normalizeAll requires', () => {
  for (const row of parseListing(html)) {
    for (const field of ['externalId', 'ship', 'departureDate', 'nights', 'price']) {
      assert.ok(row[field], `missing ${field}: ${JSON.stringify(row)}`);
    }
  }
});

test('dates are converted from the page format to ISO', () => {
  for (const row of parseListing(html)) {
    assert.match(row.departureDate, /^\d{4}-\d{2}-\d{2}$/, `not ISO: ${row.departureDate}`);
  }
});

// Princess quotes Canadian dollars. Royal Caribbean and Celebrity quote USD.
// Storing 'USD' here would make every cross-line price comparison silently wrong.
test('currency is CAD, never USD', () => {
  for (const row of parseListing(html)) {
    assert.equal(row.currency, 'CAD', 'Princess prices are CAD — do not convert or relabel');
  }
});

// The card shows a struck-through "Was" price above the real "Now" price.
// Taking the first amount on the card would systematically overstate every fare.
test('price is the Now amount, not the struck-through Was amount', () => {
  const rows = parseListing(html);
  const dec9 = rows.find((r) => r.departureDate === '2026-12-09');
  assert.ok(dec9, 'expected the 2026-12-09 Diamond Princess departure in the fixture');
  assert.equal(dec9.price, 1142, 'took the Was price (2362) instead of the Now price (1142)');
});

test('ship names are real, not slugs or codes', () => {
  for (const row of parseListing(html)) {
    assert.match(row.ship, /Princess$/, `unexpected ship name: ${row.ship}`);
  }
});

test('nights is a plausible number taken from the itinerary title', () => {
  for (const row of parseListing(html)) {
    assert.ok(Number(row.nights) > 0 && Number(row.nights) < 200, `bad nights: ${row.nights}`);
  }
});

test('externalId is unique per departure', () => {
  const ids = parseListing(html).map((r) => r.externalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate externalId values');
});

test('the fixture survives normalizeAll with no dropped rows', () => {
  const rows = parseListing(html);
  const { sailings, unrecognised } = normalizeAll(rows, { source: name, line });
  assert.equal(
    sailings.length,
    rows.length,
    `dropped: ${JSON.stringify(unrecognised.filter((u) => u.field === 'row'), null, 2)}`,
  );
});

// These four exist because the first version of the parser passed every test above
// while producing "Singapore Up to 40% Off -" as a port and one giant string as the
// ports list. Presence-and-format assertions cannot see dirty content; these can.
test('fields carry clean values, not neighbouring page furniture', () => {
  for (const row of parseListing(html)) {
    assert.ok(!/Up to 40%|FREE 3rd|Save$|Bonus/i.test(row.departurePort ?? ''),
      `promo text leaked into departurePort: ${row.departurePort}`);
    assert.ok(!/\bSave$|View details/i.test(row.itinerary ?? ''),
      `button text leaked into itinerary: ${row.itinerary}`);
    assert.ok((row.departurePort ?? '').length < 40,
      `departurePort implausibly long: ${row.departurePort}`);
  }
});

test('ports are separate entries, not one concatenated string', () => {
  const row = parseListing(html).find((r) => r.externalId === 'M634_2026-12-09');
  assert.ok(row, 'expected voyage M634 in the fixture');
  assert.ok(row.ports.length >= 4, `ports not split: ${JSON.stringify(row.ports)}`);
  for (const port of row.ports) {
    assert.ok(port.length < 60, `port entry looks concatenated: ${port}`);
  }
  assert.ok(row.ports.includes('Singapore'));
});

test('destination is the itinerary title, for normalize.js to resolve', () => {
  // Princess names no region on the card. Port countries were tried and are wrong
  // in the most misleading way — a Caribbean cruise leaving Fort Lauderdale reads
  // as "Florida". The title is the only real signal, so the adapter hands the whole
  // title over and normalize.js finds the region inside it.
  const row = parseListing(html).find((r) => r.externalId === 'M634_2026-12-09');
  assert.equal(row.destination, '10-Day Vietnam with Halong Bay');
  const { sailings } = normalizeAll([row], { source: name, line });
  assert.equal(sailings[0].destination, 'asia', 'normalize should find Vietnam in the title');
});

test('externalId uses the site voyage code, not a synthesised one', () => {
  for (const row of parseListing(html)) {
    assert.match(row.externalId, /^[A-Z][A-Z0-9]*_\d{4}-\d{2}-\d{2}$/,
      `not a voyage-coded id: ${row.externalId}`);
  }
});

test('an unrecognised page yields no rows rather than throwing', () => {
  assert.deepEqual(parseListing('<html><body>nothing here</body></html>'), []);
});

test('shipUrl slugifies to a princess.com path', () => {
  assert.equal(shipUrl('Diamond Princess'), 'https://www.princess.com/ships/diamond-princess');
  assert.equal(shipUrl('Sun Princess'), 'https://www.princess.com/ships/sun-princess');
});

test('parseShip supplies no description, deliberately', () => {
  // /ships/<slug> 404s for most Princess ships and serves the WRONG ship for
  // others — /ships/discovery-princess returns Diamond Princess's page. A wrong
  // description looks fine and is never questioned. Absent is the honest answer here.
  const got = parseShip('<html><head><meta name="description" content="anything"></head></html>');
  assert.equal(got.line, 'Princess Cruises');
  assert.equal(got.description, '');
  assert.equal(got.source, null);
});

test('the adapter declares it supplies no ship descriptions', () => {
  // scrape.js reads this and skips Princess ship pages entirely. Without it, every
  // full scrape reported 17 per-ship "failures" and exited 1, so exit 1 meant nothing.
  assert.equal(shipDescriptions, false);
});
