import test from 'node:test';
import assert from 'node:assert/strict';
import { createReporter, formatDuration } from '../progress.js';

function fakeStream(isTTY) {
  const out = { isTTY, text: '', write(s) { out.text += s; return true; } };
  return out;
}

function clock(start = 0) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('durations read as m:ss, and h:mm:ss past an hour', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(21_400), '0:21');
  assert.equal(formatDuration(8 * 60_000 + 41_000), '8:41');
  assert.equal(formatDuration(3_600_000 + 62_000), '1:01:02');
});

test('each line says when it starts and how long it took', () => {
  const stream = fakeStream(false);
  const c = clock();
  const r = createReporter({ stream, now: c.now });
  r.start('royal-caribbean');
  c.t = 21_000;
  r.end('royal-caribbean', '184 sailings');
  assert.equal(stream.text, 'royal-caribbean: fetching…\nroyal-caribbean: 184 sailings (0:21)\n');
});

test('in a terminal, progress rewrites one line in place, and the end replaces it', () => {
  const stream = fakeStream(true);
  const r = createReporter({ stream, now: clock().now });
  r.start('cunard');
  r.progress('cunard', 'page 1 · 10 priced');
  r.progress('cunard', 'page 2 · 20 priced');
  r.end('cunard', '276 sailings');
  assert.equal(
    stream.text,
    'cunard: fetching…\n'
      + '\r\x1b[Kcunard: page 1 · 10 priced'
      + '\r\x1b[Kcunard: page 2 · 20 priced'
      + '\r\x1b[Kcunard: 276 sailings (0:00)\n',
  );
});

test('into a log file, progress prints at most every 15 seconds', () => {
  const stream = fakeStream(false);
  const c = clock();
  const r = createReporter({ stream, now: c.now });
  r.start('viking');
  r.progress('viking', 'itinerary 1/69');            // too soon after start
  c.t = 15_000; r.progress('viking', 'itinerary 20/69');
  c.t = 20_000; r.progress('viking', 'itinerary 27/69'); // too soon after the last
  c.t = 30_000; r.progress('viking', 'itinerary 40/69');
  assert.equal(stream.text, 'viking: fetching…\nviking: itinerary 20/69\nviking: itinerary 40/69\n');
});

test('a message mid-progress starts on a clean line, and progress resumes after it', () => {
  const stream = fakeStream(true);
  const r = createReporter({ stream, now: clock().now });
  r.start('cunard');
  r.progress('cunard', 'page 3 · 30 priced');
  r.log('cunard: 2 of 30 price requests failed');
  r.progress('cunard', 'page 4 · 40 priced');
  assert.equal(
    stream.text,
    'cunard: fetching…\n'
      + '\r\x1b[Kcunard: page 3 · 30 priced'
      + '\r\x1b[Kcunard: 2 of 30 price requests failed\n'
      + '\r\x1b[Kcunard: page 4 · 40 priced',
  );
});

test('a failure clears the progress line before it is printed', () => {
  const stream = fakeStream(true);
  const r = createReporter({ stream, now: clock().now });
  r.start('viking');
  r.progress('viking', 'itinerary 5/69');
  r.clear();
  assert.equal(stream.text, 'viking: fetching…\n\r\x1b[Kviking: itinerary 5/69\r\x1b[K');
  r.clear(); // nothing showing: writes nothing
  assert.equal(stream.text.endsWith('\r\x1b[K\r\x1b[K'), false);
});

test('the whole run ends with its total time', () => {
  const stream = fakeStream(false);
  const c = clock();
  const r = createReporter({ stream, now: c.now });
  c.t = 16 * 60_000 + 42_000;
  r.done();
  assert.equal(stream.text, 'Done in 16:42\n');
});
