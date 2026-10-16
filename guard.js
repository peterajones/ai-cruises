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

/** null if allowed, else { status, error }. `maxBody` is for the few routes that take more. */
export function checkRequest({ method, headers, maxBody = MAX_BODY }) {
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
  if (Number(headers['content-length']) > maxBody) {
    return { status: 413, error: `Too large — the limit is ${sizeText(maxBody)}.` };
  }
  return null;
}

const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`);

/** The request body as bytes, refusing more than `maxBody` whatever was declared. */
export async function readRaw(req, maxBody = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) {
      const err = new Error(`Too large — the limit is ${sizeText(maxBody)}.`);
      err.status = 413;
      throw err;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** The request body as text, refusing more than `maxBody` bytes whatever was declared. */
export async function readBody(req, maxBody = MAX_BODY) {
  return (await readRaw(req, maxBody)).toString('utf8');
}
