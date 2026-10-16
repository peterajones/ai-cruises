import test from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders, CSP } from '../headers.js';

test('every response gets the content policy, nosniff and no referrer', () => {
  const h = securityHeaders({ deployed: false, host: 'localhost:3030', login: false });
  assert.equal(h['content-security-policy'], CSP);
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /script-src[^;]*unsafe-inline/);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /img-src 'self' https: data:/);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['referrer-policy'], 'no-referrer');
});

test('HSTS only when deployed, and never to localhost', () => {
  const on = securityHeaders({ deployed: true, host: 'ai-cruises.peter-jones.org', login: true });
  assert.equal(on['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.equal(securityHeaders({ deployed: false, host: 'ai-cruises.peter-jones.org', login: true })['strict-transport-security'], undefined);
  for (const host of ['localhost:8443', '127.0.0.1:3030', 'localhost']) {
    assert.equal(securityHeaders({ deployed: true, host, login: true })['strict-transport-security'], undefined, host);
  }
});

test('with login on, nothing is cached — Back after logging out shows nothing', () => {
  assert.equal(securityHeaders({ deployed: true, host: 'x.org', login: true })['cache-control'], 'no-store');
  assert.equal(securityHeaders({ deployed: false, host: 'localhost', login: false })['cache-control'], undefined);
});
