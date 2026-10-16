/**
 * Security headers on every response — what helmet gives MyFinancesWeb, by hand (no
 * dependencies here). The pages load scripts from files only, so the policy needs no
 * 'unsafe-inline' for scripts; styles stay inline. Photos are hotlinked from the lines'
 * own sites, hence img-src https:.
 */
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:", "connect-src 'self'", "font-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * @param {{deployed: boolean, host: string, login: boolean}} at - deployed: HOST is public;
 *   host: the request's Host header; login: the login is on.
 */
export function securityHeaders({ deployed, host, login }) {
  const h = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  // Never to localhost: a browser that pinned HSTS for localhost would force the Mac's own
  // http://localhost:3030 to HTTPS from then on.
  if (deployed && !LOCAL.test(host ?? '')) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  // Logged out, Back must not show the pages or answers from the browser's cache.
  if (login) h['cache-control'] = 'no-store';
  return h;
}
