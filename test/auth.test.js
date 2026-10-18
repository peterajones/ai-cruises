import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  hashPassword, verifyPassword, isPasswordHash, checkNewPassword, signToken, verifyToken,
  sessionCookie, clearedCookie, readCookie, createLimiter, tooManyMessage, clientAddress,
  authConfig, startupProblems, isOpenPath, attemptLogin,
} from '../auth.js';

const SECRET = 's'.repeat(40);
const HASH = hashPassword('correct horse battery');
const DAY = 86_400_000;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const forge = (header, claims, secret = SECRET) => {
  const head = `${b64(header)}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
};
const claimsFor = (hash = HASH, now = Date.now()) => JSON.parse(Buffer.from(signToken({ secret: SECRET, passwordHash: hash, now }).split('.')[1], 'base64url'));

test('a password hash verifies its own password and nothing else', () => {
  assert.ok(isPasswordHash(HASH));
  assert.match(HASH, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.ok(verifyPassword('correct horse battery', HASH));
  assert.equal(verifyPassword('correct horse batterz', HASH), false);
  assert.equal(verifyPassword('', HASH), false);
  assert.equal(verifyPassword('correct horse battery', 'not a hash'), false);
  assert.notEqual(hashPassword('same password!'), hashPassword('same password!'), 'salted');
});

test('a new password needs 12 characters, typed the same twice', () => {
  assert.match(checkNewPassword('short', 'short'), /12 characters/);
  assert.match(checkNewPassword('long enough pw', 'long enough pX'), /didn.t match/);
  assert.equal(checkNewPassword('long enough pw', 'long enough pw'), null);
});

test('a token we signed is accepted, with a 30-day expiry', () => {
  const now = Date.now();
  const claims = verifyToken(signToken({ secret: SECRET, passwordHash: HASH, now }), { secret: SECRET, passwordHash: HASH, now });
  assert.ok(claims);
  assert.equal(claims.exp - claims.iat, 30 * 86_400);
});

test('tokens that try to get in are refused', () => {
  const now = Date.now();
  const good = signToken({ secret: SECRET, passwordHash: HASH, now });
  const opts = { secret: SECRET, passwordHash: HASH, now };
  const [h, p, s] = good.split('.');
  const flip = (c) => (c === 'A' ? 'B' : 'A');
  const cases = {
    'tampered signature': `${h}.${p}.${flip(s[0])}${s.slice(1)}`,
    'tampered claims': `${h}.${b64({ ...claimsFor(HASH, now), exp: claimsFor(HASH, now).exp + 9999 })}.${s}`,
    'alg none': `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`,
    'alg HS512': forge({ alg: 'HS512', typ: 'JWT' }, claimsFor(HASH, now)),
    'wrong secret': forge({ alg: 'HS256', typ: 'JWT' }, claimsFor(HASH, now), 'x'.repeat(40)),
    'expired': signToken({ secret: SECRET, passwordHash: HASH, now: now - 31 * DAY }),
    'before a password change': signToken({ secret: SECRET, passwordHash: hashPassword('an older password'), now }),
    'two parts': `${h}.${p}`,
    'four parts': `${good}.x`,
    'garbage': 'not-a-token',
    'empty': '',
    'not base64 json': 'e30.e30.e30',
  };
  for (const [name, token] of Object.entries(cases)) assert.equal(verifyToken(token, opts), null, name);
  assert.equal(verifyToken(undefined, opts), null, 'no cookie');
});

test('the session cookie is HttpOnly, Secure, SameSite=Strict, 30 days', () => {
  assert.equal(sessionCookie('abc'), 'session=abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000');
  assert.equal(clearedCookie(), 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  assert.equal(readCookie('a=1; session=xyz; b=2', 'session'), 'xyz');
  assert.equal(readCookie(undefined, 'session'), null);
  assert.equal(readCookie('sessionx=1', 'session'), null);
});

test('five wrong guesses from one address wait 15 minutes; other addresses do not', () => {
  const clock = { t: 0 };
  const limiter = createLimiter({ now: () => clock.t });
  for (let i = 0; i < 5; i += 1) { assert.equal(limiter.blocked('1.1.1.1'), 0); limiter.fail('1.1.1.1'); }
  assert.ok(limiter.blocked('1.1.1.1') > 14 * 60_000);
  assert.equal(limiter.blocked('2.2.2.2'), 0);
  assert.equal(tooManyMessage(12 * 60_000 - 1), 'Too many attempts — try again in 12 minutes.');
  clock.t = 15 * 60_000 + 1;
  assert.equal(limiter.blocked('1.1.1.1'), 0);
});

test('a successful login clears that address’s count', () => {
  const limiter = createLimiter({ now: () => 0 });
  for (let i = 0; i < 4; i += 1) limiter.fail('1.1.1.1');
  limiter.succeed('1.1.1.1');
  limiter.fail('1.1.1.1');
  assert.equal(limiter.blocked('1.1.1.1'), 0);
});

test('behind the proxy, the address is the last X-Forwarded-For entry; earlier ones are forgeable', () => {
  assert.equal(clientAddress({ socketAddress: '10.0.0.5', forwardedFor: '6.6.6.6, 203.0.113.9', trustProxy: true }), '203.0.113.9');
  assert.equal(clientAddress({ socketAddress: '10.0.0.5', forwardedFor: '203.0.113.9', trustProxy: true }), '203.0.113.9');
  assert.equal(clientAddress({ socketAddress: '10.0.0.5', forwardedFor: undefined, trustProxy: true }), '10.0.0.5');
  assert.equal(clientAddress({ socketAddress: '10.0.0.5', forwardedFor: '203.0.113.9', trustProxy: false }), '10.0.0.5');
});

test('login is on with both settings; half-set or weak settings are problems', () => {
  assert.deepEqual(authConfig({}).on, false);
  assert.deepEqual(authConfig({}).problems, []);
  const both = authConfig({ JWT_SECRET: SECRET, LOGIN_PASSWORD_HASH: HASH });
  assert.equal(both.on, true);
  assert.deepEqual(both.problems, []);
  assert.match(authConfig({ JWT_SECRET: SECRET }).problems.join(), /LOGIN_PASSWORD_HASH/);
  assert.match(authConfig({ LOGIN_PASSWORD_HASH: HASH }).problems.join(), /JWT_SECRET/);
  assert.match(authConfig({ JWT_SECRET: 'short', LOGIN_PASSWORD_HASH: HASH }).problems.join(), /32 characters/);
  assert.match(authConfig({ JWT_SECRET: SECRET, LOGIN_PASSWORD_HASH: 'hunter2' }).problems.join(), /hash-password/);
});

test('a public server refuses to start without login, or without ratings', () => {
  const ok = { ok: true };
  const login = { JWT_SECRET: SECRET, LOGIN_PASSWORD_HASH: HASH };
  assert.deepEqual(startupProblems({ env: {}, host: '127.0.0.1', selections: ok }), []);
  assert.deepEqual(startupProblems({ env: {}, host: '127.0.0.1', selections: { ok: false, reason: 'old Node' } }), []);
  assert.match(startupProblems({ env: {}, host: '0.0.0.0', selections: ok }).join(), /Login is required/);
  assert.deepEqual(startupProblems({ env: { ...login, TRUST_PROXY: '1' }, host: '0.0.0.0', selections: ok }), []);
  assert.deepEqual(startupProblems({ env: { ...login, TRUST_PROXY: '0' }, host: '0.0.0.0', selections: ok }), []);
  assert.match(startupProblems({ env: login, host: '0.0.0.0', selections: ok }).join(), /TRUST_PROXY must be set when HOST is 0\.0\.0\.0: 1 behind a proxy such as Coolify's \(it reads the client's address from X-Forwarded-For\), 0 if nothing is in front\./);
  assert.match(startupProblems({ env: { ...login, TRUST_PROXY: 'yes' }, host: '0.0.0.0', selections: ok }).join(), /TRUST_PROXY/);
  assert.deepEqual(startupProblems({ env: login, host: '127.0.0.1', selections: ok }), []);
  assert.match(startupProblems({ env: { ...login, TRUST_PROXY: '1' }, host: '0.0.0.0', selections: { ok: false, reason: 'old Node' } }).join(), /old Node/);
  assert.match(startupProblems({ env: { SYNC_KEY: 'short' }, host: '127.0.0.1', selections: ok }).join(), /SYNC_KEY/);
  assert.match(startupProblems({ env: { JWT_SECRET: SECRET }, host: '127.0.0.1', selections: ok }).join(), /LOGIN_PASSWORD_HASH/);
});

test('only the login page, its files, health and the sync routes are open', () => {
  for (const [m, p] of [['GET', '/login'], ['GET', '/login.js'], ['GET', '/favicon-light-mode.png'],
    ['GET', '/favicon-dark-mode.png'], ['GET', '/healthz'], ['POST', '/api/login'], ['POST', '/api/logout'],
    ['GET', '/manifest.webmanifest'], ['GET', '/apple-touch-icon.png'], ['GET', '/icon-192.png'], ['GET', '/icon-512.png'],
    ['PUT', '/api/sync/sailings'], ['GET', '/api/sync/selections']]) {
    assert.ok(isOpenPath(m, p), `${m} ${p}`);
  }
  for (const [m, p] of [['GET', '/'], ['GET', '/index.html'], ['GET', '/index.js'], ['GET', '/mine'],
    ['GET', '/search.js'], ['GET', '/session.js'], ['GET', '/api/dataset'], ['POST', '/api/search'],
    ['GET', '/api/selections'], ['PUT', '/api/selections/rating'], ['GET', '/api/flights'], ['GET', '/api/status'],
    ['GET', '/api/refresh'], ['GET', '/api/login'], ['GET', '/login/../index.html'], ['GET', '/api/syncx']]) {
    assert.equal(isOpenPath(m, p), false, `${m} ${p}`);
  }
});

test('a login attempt is counted before the password is checked', () => {
  const calls = [];
  const limiter = { blocked: () => 0, fail: () => calls.push('fail'), succeed: () => calls.push('succeed') };
  // A wrong password: the failure is already recorded when the (slow) check finishes.
  assert.equal(attemptLogin('wrong', { address: 'a', limiter, passwordHash: HASH }).status, 401);
  assert.deepEqual(calls, ['fail']);
  calls.length = 0;
  assert.equal(attemptLogin('correct horse battery', { address: 'a', limiter, passwordHash: HASH }).status, 204);
  assert.deepEqual(calls, ['fail', 'succeed'], 'fail first, then cleared on success');
});

test('attemptLogin: wrong passwords are 401, then the sixth is 429 even if right', () => {
  const limiter = createLimiter({ now: () => 0 });
  const opts = { address: '1.1.1.1', limiter, passwordHash: HASH };
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(attemptLogin('nope', opts), { status: 401, error: 'Wrong password' });
  }
  const out = attemptLogin('correct horse battery', opts);
  assert.equal(out.status, 429);
  assert.match(out.error, /Too many attempts/);
});

test('attemptLogin: the right password clears the count', () => {
  const limiter = createLimiter({ now: () => 0 });
  const opts = { address: '1.1.1.1', limiter, passwordHash: HASH };
  for (let i = 0; i < 4; i += 1) attemptLogin('nope', opts);
  assert.equal(attemptLogin('correct horse battery', opts).status, 204);
  for (let i = 0; i < 5; i += 1) assert.equal(attemptLogin('nope', opts).status, 401, `wrong #${i + 1}`);
  assert.equal(attemptLogin('nope', opts).status, 429);
});

test('attemptLogin: a password that is not a string is a counted failure', () => {
  for (const bad of [null, 123, {}, undefined]) {
    const limiter = createLimiter({ now: () => 0 });
    const opts = { address: '1.1.1.1', limiter, passwordHash: HASH };
    assert.equal(attemptLogin(bad, opts).status, 401);
    for (let i = 0; i < 4; i += 1) attemptLogin(bad, opts);
    assert.ok(limiter.blocked('1.1.1.1') > 0, `counted: ${String(bad)}`);
  }
});
