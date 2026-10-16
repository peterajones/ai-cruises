import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const PUBLIC = new URL('../public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUBLIC), 'utf8');
const files = readdirSync(PUBLIC);

test('pages load every script from a file (the content policy allows no inline script)', () => {
  for (const f of files.filter((n) => n.endsWith('.html'))) {
    const html = read(f);
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1]));
    assert.deepEqual(inline.map((m) => m[0]), [], `${f} has an inline script`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${f} has an inline event handler`);
    assert.doesNotMatch(html, /javascript:/i, `${f} has a javascript: URL`);
  }
});

test('scripts never write inline event handlers into markup', () => {
  for (const f of files.filter((n) => n.endsWith('.js'))) {
    assert.doesNotMatch(read(f), /\son[a-z]+=\\?["']/, `${f} writes an inline handler`);
  }
});
