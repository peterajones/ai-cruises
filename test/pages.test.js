import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isOpenPath } from '../auth.js';

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

// Home-screen app. Width, height and colour type sit at fixed offsets in a PNG's header.
function pngInfo(f) {
  const b = readFileSync(new URL(f.replace(/^\//, ''), PUBLIC));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

test('every page offers the home-screen app', () => {
  for (const f of files.filter((n) => n.endsWith('.html'))) {
    const html = read(f);
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, `${f} has no manifest`);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/, `${f} has no iPhone icon`);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Cruises">/, `${f} has no home-screen title`);
  }
});

test('the home-screen icons exist at their stated sizes, opaque, and open without a login', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const icons = [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180' }];
  for (const { src, sizes } of icons) {
    const { width, height, colorType } = pngInfo(src);
    assert.equal(`${width}x${height}`, sizes, src);
    // Colour type 2 is RGB without alpha. iOS paints transparency black.
    assert.equal(colorType, 2, `${src} has transparency`);
    // Browsers fetch the manifest without cookies, so behind the login it would
    // come back as a redirect to /login and the app would have no icon or name.
    assert.ok(isOpenPath('GET', src), `${src} is behind the login`);
  }
  assert.ok(isOpenPath('GET', '/manifest.webmanifest'), 'the manifest is behind the login');
});
