import puppeteer from 'puppeteer';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/** Minimum gap between page loads. Nothing here needs to be fast; an IP block costs a day. */
export const POLITE_DELAY_MS = 1500;

const STRONG_SIGNATURES = [
  [/_Incapsula_Resource|Incapsula incident/i, 'Incapsula challenge page'],
  [/cf-browser-verification/i, 'Cloudflare interstitial'],
  [/px-captcha|PerimeterX/i, 'PerimeterX captcha'],
];

const WEAK_SIGNATURES = [
  [/Just a moment\.\.\./i, 'Cloudflare interstitial'],
  [/Access Denied|You have been blocked/i, 'access denied'],
];

/**
 * Pure. Returns a human-readable reason, or null if the body looks like content.
 * Distinguishes unambiguous vendor markers (strong) from ordinary English (weak).
 * Weak signatures only fire if the page is small OR the phrase appears in <title>.
 * @param {string} body
 * @returns {string|null}
 */
export function detectBotWall(body) {
  const text = String(body ?? '');
  const textTrimmed = text.trim();
  const isSmall = textTrimmed.length < 1000;

  // Extract title for weak signature matching
  const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';

  // Check STRONG signatures - unambiguous vendor markers, fire anywhere
  for (const [pattern, reason] of STRONG_SIGNATURES) {
    if (pattern.test(text)) return reason;
  }

  // Check WEAK signatures - ordinary English, fire only if page is small OR in title
  for (const [pattern, reason] of WEAK_SIGNATURES) {
    if (pattern.test(text) && (isSmall || pattern.test(title))) {
      return reason;
    }
  }

  // A real listing page is never a few hundred bytes. A stub this small is a block.
  if (isSmall) return `response too small (${textTrimmed.length} bytes)`;
  return null;
}

export function politeDelay(ms = POLITE_DELAY_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launch() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
}

export async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1440, height: 900 });
  return page;
}
