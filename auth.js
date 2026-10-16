/**
 * The login: one user (Peter), a password hash in a setting, an HS256 JWT in a cookie.
 * MyFinancesWeb's design trimmed to one user and no dependencies — node:crypto signs and
 * hashes. Spec: docs/superpowers/specs/2026-10-16-deployment-design.md, part 4.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD = 12;
export const MIN_SECRET = 32;
const SESSION_SECONDS = 30 * 86_400;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const HASH_FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]{16,})\$([\w-]{40,})$/;

export function hashPassword(password, salt = randomBytes(16)) {
  const { N, r, p, keylen, maxmem } = SCRYPT;
  const hash = scryptSync(password, salt, keylen, { N, r, p, maxmem });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export const isPasswordHash = (stored) => HASH_FORMAT.test(stored ?? '');

export function verifyPassword(password, stored) {
  const m = HASH_FORMAT.exec(stored ?? '');
  if (!m || typeof password !== 'string') return false;
  const [, N, r, p, salt, hash] = m;
  const expected = Buffer.from(hash, 'base64url');
  const given = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(given, expected);
}

export function checkNewPassword(a, b) {
  if (typeof a !== 'string' || a.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (a !== b) return 'The two passwords didn’t match.';
  return null;
}

const b64json = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const HEADER = b64json({ alg: 'HS256', typ: 'JWT' });
/** Ties a session to this password: a new password ends every session made with the old one. */
const fingerprint = (passwordHash) => createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

export function signToken({ secret, passwordHash, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const body = `${HEADER}.${b64json({ iat, exp: iat + SESSION_SECONDS, pwf: fingerprint(passwordHash) })}`;
  return `${body}.${sign(secret, body)}`;
}

const parseJson = (part) => {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
};

/** The claims, or null. Every check must pass; there is no partial trust. */
export function verifyToken(token, { secret, passwordHash, now = Date.now() }) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const header = parseJson(h);
  if (!header || header.alg !== 'HS256') return null; // only HS256: never 'none', never another key type
  const expected = Buffer.from(sign(secret, `${h}.${p}`));
  const given = Buffer.from(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = parseJson(p);
  if (!claims || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(now / 1000)) return null;
  if (claims.pwf !== fingerprint(passwordHash)) return null;
  return claims;
}

const COOKIE = 'HttpOnly; Secure; SameSite=Strict; Path=/';
export const sessionCookie = (token) => `session=${token}; ${COOKIE}; Max-Age=${SESSION_SECONDS}`;
export const clearedCookie = () => `session=; ${COOKIE}; Max-Age=0`;

export function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Wrong passwords and wrong sync keys, per address. In memory: a restart resets it. */
export function createLimiter({ max = 5, windowMs = 15 * 60_000, now = Date.now } = {}) {
  const seen = new Map(); // address → { count, first }
  const fresh = (addr) => {
    const entry = seen.get(addr);
    if (entry && now() - entry.first > windowMs) { seen.delete(addr); return null; }
    return entry ?? null;
  };
  return {
    /** Milliseconds to wait, or 0. */
    blocked(addr) {
      const entry = fresh(addr);
      return entry && entry.count >= max ? entry.first + windowMs - now() : 0;
    },
    fail(addr) {
      for (const [a, e] of seen) if (now() - e.first > windowMs) seen.delete(a);
      const entry = fresh(addr);
      if (entry) entry.count += 1;
      else seen.set(addr, { count: 1, first: now() });
    },
    succeed(addr) { seen.delete(addr); },
  };
}

export const tooManyMessage = (ms) => `Too many attempts — try again in ${Math.max(1, Math.ceil(ms / 60_000))} minutes.`;

/**
 * Behind Coolify's proxy every request comes from the proxy. The proxy appends the address
 * it saw to X-Forwarded-For; anything before that came from the client and can be forged.
 */
export function clientAddress({ socketAddress, forwardedFor, trustProxy }) {
  if (trustProxy && forwardedFor) {
    const last = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return socketAddress ?? 'unknown';
}

export function authConfig(env) {
  const secret = env.JWT_SECRET ?? '';
  const passwordHash = env.LOGIN_PASSWORD_HASH ?? '';
  const problems = [];
  if (secret || passwordHash) {
    if (!secret) problems.push('JWT_SECRET is missing (npm run make-key makes one).');
    else if (secret.length < MIN_SECRET) problems.push(`JWT_SECRET must be at least ${MIN_SECRET} characters (npm run make-key).`);
    if (!passwordHash) problems.push('LOGIN_PASSWORD_HASH is missing (npm run hash-password makes one).');
    else if (!isPasswordHash(passwordHash)) problems.push('LOGIN_PASSWORD_HASH is not a hash from npm run hash-password.');
  }
  return { on: Boolean(secret && passwordHash) && problems.length === 0, secret, passwordHash, problems };
}

export const isLocalHost = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);

/** Why the server must not start, or []. */
export function startupProblems({ env, host, selections }) {
  const auth = authConfig(env);
  const problems = [...auth.problems];
  if (!isLocalHost(host)) {
    if (!auth.on && auth.problems.length === 0) {
      problems.push(`Login is required when HOST is ${host}: set JWT_SECRET and LOGIN_PASSWORD_HASH.`);
    }
    if (!selections?.ok) problems.push(`Ratings could not open: ${selections?.reason ?? 'unknown'}`);
  }
  if (env.SYNC_KEY !== undefined && env.SYNC_KEY.length < MIN_SECRET) {
    problems.push(`SYNC_KEY must be at least ${MIN_SECRET} characters (npm run make-key).`);
  }
  return problems;
}

const OPEN = new Set(['GET /login', 'GET /login.js', 'GET /favicon-light-mode.png', 'GET /favicon-dark-mode.png',
  'GET /healthz', 'POST /api/login', 'POST /api/logout']);

/** Reachable without a session. The sync routes check their own key. */
export function isOpenPath(method, path) {
  return OPEN.has(`${method} ${path}`) || path.startsWith('/api/sync/');
}
