import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { health } from '../health.js';

const dir = mkdtempSync(join(tmpdir(), 'health-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, text) => { const f = join(dir, name); if (text !== undefined) writeFileSync(f, text); return f; };

test('healthy with data and ratings', async () => {
  assert.deepEqual(await health({ selections: { ok: true }, dataFile: file('ok.json', '{"sailings":[]}') }), { status: 200, text: 'ok' });
});

test('no data yet is still healthy — the first deploy starts empty', async () => {
  assert.deepEqual(await health({ selections: { ok: true }, dataFile: file('missing.json') }), { status: 200, text: 'ok — no data yet' });
});

test('unreadable data or ratings are unhealthy, and say nothing more', async () => {
  assert.equal((await health({ selections: { ok: true }, dataFile: file('bad.json', '{oops') })).status, 503);
  assert.equal((await health({ selections: { ok: false, reason: 'x' }, dataFile: file('ok2.json', '{}') })).status, 503);
  assert.equal((await health({ selections: { ok: false, reason: 'secret path' }, dataFile: file('ok3.json', '{}') })).text, 'unhealthy');
});
