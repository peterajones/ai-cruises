import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBotWall, USER_AGENT } from '../browser.js';

const INCAPSULA = `<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">
<script type="text/javascript" src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e"></script></head>
<body><iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=31">
Request unsuccessful. Incapsula incident ID: 1848000740416814348</iframe></body></html>`;

const CLOUDFLARE = `<html><head><title>Just a moment...</title></head>
<body><div class="cf-browser-verification">Checking your browser</div></body></html>`;

const REAL_PAGE = `<html><head><title>Find a Cruise</title></head><body>
<div class="results">${'<div class="sailing">7 Night Caribbean</div>'.repeat(60)}</div></body></html>`;

test('catches an Incapsula challenge', () => {
  assert.match(detectBotWall(INCAPSULA), /incapsula/i);
});

test('catches a Cloudflare interstitial', () => {
  assert.match(detectBotWall(CLOUDFLARE), /cloudflare|just a moment/i);
});

test('catches a suspiciously tiny body with no signature', () => {
  assert.match(detectBotWall('<html><body>hi</body></html>'), /too small/i);
});

test('a real page is not a bot wall', () => {
  assert.equal(detectBotWall(REAL_PAGE), null);
});

test('a large page with "Access Denied" in body but not title is not a bot wall', () => {
  const largeBody = `<html><head><title>Find a Cruise</title></head><body>
<div class="results">${'<div class="sailing">Access Denied in ad</div>'.repeat(60)}</div></body></html>`;
  assert.equal(detectBotWall(largeBody), null);
});

test('a small page with "Access Denied" in title is caught', () => {
  assert.match(detectBotWall('<html><head><title>Access Denied</title></head><body>error</body></html>'), /access denied/i);
});

test('the user agent is a plausible desktop Chrome', () => {
  assert.match(USER_AGENT, /^Mozilla\/5\.0 \(Macintosh.*Chrome\/\d+/);
});
