/**
 * Who may call /api/. Every route spends something: ratings, Anthropic credit (search),
 * or the 250-a-month SerpApi quota (flights) — so only this app's own pages get in.
 *
 * Browsers label every request with where it came from (Sec-Fetch-Site, and Origin on
 * writes). Tools like curl send neither, and are let through: this stops other websites
 * using your browser against the app, not someone calling it directly — that needs a login.
 */
export const MAX_BODY = 64 * 1024;

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** null if allowed, else { status, error }. */
export function checkRequest({ method, headers }) {
  const site = headers['sec-fetch-site'];
  // 'none' is the address bar or a bookmark. 'same-site' includes other ports on localhost.
  if (site && site !== 'same-origin' && site !== 'none') {
    return { status: 403, error: 'Only this app’s own pages can use its API.' };
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* 'null' and other junk */ }
    if (originHost !== headers.host) {
      return { status: 403, error: 'Only this app’s own pages can use its API.' };
    }
  }
  if (WRITES.has(method)) {
    // A cross-site form can only send text/plain, urlencoded or multipart — never JSON.
    const type = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      return { status: 415, error: 'Send JSON (content-type: application/json).' };
    }
  }
  if (Number(headers['content-length']) > MAX_BODY) {
    return { status: 413, error: `Too large — the limit is ${MAX_BODY / 1024} KB.` };
  }
  return null;
}

/** The request body as text, refusing more than MAX_BODY bytes whatever was declared. */
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error(`Too large — the limit is ${MAX_BODY / 1024} KB.`);
      err.status = 413;
      throw err;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
