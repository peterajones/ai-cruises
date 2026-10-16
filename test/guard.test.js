import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { checkRequest, readBody, readRaw, MAX_BODY } from '../guard.js';

const host = 'localhost:3030';

test('the app’s own page may call the API', () => {
  assert.equal(checkRequest({ method: 'GET', headers: { host, 'sec-fetch-site': 'same-origin' } }), null);
  assert.equal(checkRequest({
    method: 'PUT',
    headers: { host, 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3030', 'content-type': 'application/json' },
  }), null);
});

test('a tool with no browser headers (curl) may call the API', () => {
  assert.equal(checkRequest({ method: 'GET', headers: { host } }), null);
  assert.equal(checkRequest({ method: 'POST', headers: { host, 'content-type': 'application/json' } }), null);
});

test('typing the address into the browser is allowed', () => {
  assert.equal(checkRequest({ method: 'GET', headers: { host, 'sec-fetch-site': 'none' } }), null);
});

test('another website is refused, even for a plain GET', () => {
  const out = checkRequest({ method: 'GET', headers: { host, 'sec-fetch-site': 'cross-site' } });
  assert.equal(out.status, 403);
});

test('another app on localhost (same-site, different port) is refused', () => {
  const out = checkRequest({
    method: 'POST',
    headers: { host, 'sec-fetch-site': 'same-site', origin: 'http://localhost:5173', 'content-type': 'application/json' },
  });
  assert.equal(out.status, 403);
});

test('a foreign Origin is refused even without Sec-Fetch-Site (older browsers)', () => {
  assert.equal(checkRequest({ method: 'POST', headers: { host, origin: 'https://evil.example', 'content-type': 'application/json' } }).status, 403);
  assert.equal(checkRequest({ method: 'POST', headers: { host, origin: 'null', 'content-type': 'application/json' } }).status, 403);
});

test('a write that is not JSON is refused — a cross-site form cannot send JSON', () => {
  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const headers = { host };
    if (type) headers['content-type'] = type;
    assert.equal(checkRequest({ method: 'PUT', headers }).status, 415, String(type));
  }
  assert.equal(checkRequest({ method: 'POST', headers: { host, 'content-type': 'application/json; charset=utf-8' } }), null);
});

test('a declared body over the limit is refused', () => {
  const headers = { host, 'content-type': 'application/json', 'content-length': String(MAX_BODY + 1) };
  assert.equal(checkRequest({ method: 'POST', headers }).status, 413);
  headers['content-length'] = String(MAX_BODY);
  assert.equal(checkRequest({ method: 'POST', headers }), null);
});

test('readBody returns the body', async () => {
  assert.equal(await readBody(Readable.from(['{"q":', '"alaska"}'])), '{"q":"alaska"}');
});

test('readBody stops at the limit even when no length was declared', async () => {
  const big = Readable.from([Buffer.alloc(MAX_BODY), Buffer.from('x')]);
  await assert.rejects(readBody(big), (err) => err.status === 413);
});

test('a route may allow a bigger body than the 64 KB default', () => {
  const headers = { host, 'content-type': 'application/json', 'content-length': String(MAX_BODY + 1) };
  assert.equal(checkRequest({ method: 'PUT', headers }).status, 413);
  assert.equal(checkRequest({ method: 'PUT', headers, maxBody: 20 * 1024 * 1024 }), null);
});

test('readRaw returns the bytes, and refuses past its limit', async () => {
  assert.deepEqual(await readRaw(Readable.from([Buffer.from([1, 2]), Buffer.from([3])]), 10), Buffer.from([1, 2, 3]));
  await assert.rejects(readRaw(Readable.from([Buffer.alloc(11)]), 10), (err) => err.status === 413);
});
