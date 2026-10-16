import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRefresher, MAX_LINES } from '../refresh.js';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.killed = null;
  c.kill = (signal) => { c.killed = signal; setImmediate(() => c.emit('close', null, signal)); };
  return c;
}
const settle = () => new Promise((r) => setImmediate(r));
async function until(check) {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await settle(); }
  throw new Error('timed out waiting');
}

/** A refresher with a fake scrape, fake file times and a fake clock. */
function rig({ upload = async () => ({ stored: 4300, was: 4291 }), pull = async () => ({ copied: 3 }), sync = true } = {}) {
  const t = { runs: 0, mtime: 1, clock: 0, child: null, uploads: 0, pulls: 0 };
  t.r = createRefresher({
    sync: sync ? { upload: async () => { t.uploads += 1; return upload(); }, pull: async () => { t.pulls += 1; return pull(); } } : null,
    dataFile: '/nowhere/sailings.json',
    run: () => { t.runs += 1; t.child = fakeChild(); return t.child; },
    mtime: async () => t.mtime,
    now: () => t.clock,
  });
  t.finish = async ({ code = 0, written = true, out = '' } = {}) => {
    if (out) t.child.stdout.write(out);
    await settle();
    if (written) t.mtime = 2;
    t.clock = 24 * 60_000 + 12_000;
    t.child.emit('close', code, null);
  };
  return t;
}

test('without SYNC_URL and SYNC_KEY there is no Refresh', async () => {
  const t = rig({ sync: false });
  assert.equal(t.r.status().available, false);
  assert.match((await t.r.start()).error, /SYNC_URL/);
  assert.equal(t.runs, 0);
});

test('one scrape at a time: a second start gets the running one', async () => {
  const t = rig();
  await t.r.start();
  const again = await t.r.start();
  assert.equal(t.runs, 1);
  assert.equal(again.state, 'running');
});

test('the panel gets the scrape’s lines, the last 500', async () => {
  const t = rig();
  await t.r.start();
  t.child.stdout.write(Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n') + '\n');
  t.child.stderr.write('cunard: page 3 · 20 priced\n');
  await settle();
  const { lines } = t.r.status();
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines.at(-1), 'cunard: page 3 · 20 priced');
});

test('success: upload, then copy the ratings, then say so', async () => {
  const t = rig();
  await t.r.start();
  await t.finish({ out: 'royal-caribbean: 2081 sailings (0:18)\n' });
  await until(() => t.r.status().state === 'done');
  assert.equal(t.r.status().result.text, 'Done in 24:12 — 4,300 sailings · uploaded to the server ✓ · ratings copied from the server ✓');
  assert.deepEqual(t.r.status().result.failures, []);
  assert.equal(t.uploads, 1);
  assert.equal(t.pulls, 1);
});

test('a line failed but the file was written: still uploaded, failures listed', async () => {
  const t = rig();
  await t.r.start();
  await t.finish({ code: 1, out: 'princess: kept 98 sailings from the previous run\n\n1 failure(s):\n  princess listing: timed out\n\nDone in 25:06\n' });
  await until(() => t.r.status().state === 'done');
  assert.deepEqual(t.r.status().result.failures, ['princess listing: timed out']);
  assert.equal(t.uploads, 1);
});

test('nothing written: nothing uploaded, and the panel says the server keeps its data', async () => {
  const t = rig();
  await t.r.start();
  await t.finish({ code: 1, written: false });
  await until(() => t.r.status().state === 'failed');
  assert.equal(t.r.status().result.text, 'Nothing changed — the server keeps its data.');
  assert.equal(t.uploads, 0);
});

test('Stop ends the scrape; nothing is uploaded', async () => {
  const t = rig();
  await t.r.start();
  t.r.stop();
  assert.equal(t.child.killed, 'SIGTERM');
  await until(() => t.r.status().state === 'stopped');
  assert.match(t.r.status().result.text, /Stopped/);
  assert.equal(t.uploads, 0);
});

test('a failed upload can be tried again on its own', async () => {
  let fail = true;
  const t = rig({ upload: async () => { if (fail) throw new Error('Could not reach https://x (ECONNREFUSED).'); return { stored: 4300, was: 4291 }; } });
  await t.r.start();
  await t.finish();
  await until(() => t.r.status().state === 'failed');
  assert.match(t.r.status().result.text, /upload failed: Could not reach/);
  assert.equal(t.r.status().result.retry, 'upload');
  fail = false;
  t.r.retry('upload');
  await until(() => t.r.status().state === 'done');
  assert.equal(t.runs, 1, 'no second scrape');
});

test('a failed ratings copy is retried without uploading again', async () => {
  let fail = true;
  const t = rig({ pull: async () => { if (fail) throw new Error('The server answered 503.'); return { copied: 1 }; } });
  await t.r.start();
  await t.finish();
  await until(() => t.r.status().state === 'failed');
  assert.equal(t.r.status().result.retry, 'pull');
  assert.match(t.r.status().result.text, /uploaded to the server ✓ · copying ratings failed/);
  fail = false;
  t.r.retry('pull');
  await until(() => t.r.status().state === 'done');
  assert.equal(t.uploads, 1);
});

test('a scrape that cannot start says so, instead of staying "running"', async () => {
  const t = rig();
  await t.r.start();
  t.child.emit('error', new Error('spawn node ENOENT'));
  t.child.emit('close', -2, null);
  await until(() => t.r.status().state === 'failed');
  assert.match(t.r.status().result.text, /could not start: spawn node ENOENT/);
  assert.equal(t.uploads, 0);
});
