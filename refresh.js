/**
 * The Mac's Refresh: runs the scrape as a child process, keeps its lines for the panel, then
 * uploads sailings.json and copies the server's ratings. One at a time. Lives in the server
 * process: closing the tab doesn't stop it; stopping the server does.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { formatDuration } from './progress.js';

export const MAX_LINES = 500;
const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
const BUSY = new Set(['running', 'uploading', 'pulling']);

/** REFRESH_ARGS adds flags for checks (e.g. "--site viking --limit 5"); a real Refresh has none. */
export function defaultRun(args = (process.env.REFRESH_ARGS ?? '').split(/\s+/).filter(Boolean)) {
  return spawn(process.execPath, ['scrape.js', ...args], {
    cwd: APP_DIR,
    env: { ...process.env, SCRAPE_PROGRESS_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const mtimeOf = async (file) => {
  try { return (await stat(file)).mtimeMs; } catch { return 0; }
};

export function createRefresher({ sync, dataFile, run = defaultRun, mtime = mtimeOf, now = Date.now, killAfterMs = 10_000 }) {
  let state = 'idle';
  let startedAt = null;
  let startMs = 0;
  let lines = [];
  let result = null;
  let child = null;
  let stopping = false;
  let before = 0;
  let summary = null; // { took, failures } once the scrape has ended with a written file
  let uploaded = null;

  const add = (text) => {
    for (const line of String(text).split(/\r\n|\n|\r/)) if (line.trim()) lines.push(line);
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  };

  /** The block scrape.js prints at the end: "N failure(s):" then indented lines. */
  const failuresIn = () => {
    const i = lines.findLastIndex((l) => /^\d+ failure\(s\):$/.test(l));
    if (i < 0) return [];
    const out = [];
    for (const l of lines.slice(i + 1)) {
      if (!/^\s{2}\S/.test(l)) break;
      out.push(l.trim());
    }
    return out;
  };

  const count = () => uploaded.stored.toLocaleString('en-US');

  async function syncFrom(step) {
    const { took, failures } = summary;
    if (step === 'upload') {
      state = 'uploading';
      try {
        uploaded = await sync.upload();
      } catch (err) {
        state = 'failed';
        result = { text: `Done in ${took}, but the upload failed: ${err.message}`, failures, retry: 'upload' };
        return;
      }
    }
    state = 'pulling';
    try {
      await sync.pull();
    } catch (err) {
      state = 'failed';
      result = { text: `Done in ${took} — ${count()} sailings · uploaded to the server ✓ · copying ratings failed: ${err.message}`, failures, retry: 'pull' };
      return;
    }
    state = 'done';
    result = { text: `Done in ${took} — ${count()} sailings · uploaded to the server ✓ · ratings copied from the server ✓`, failures, retry: null };
  }

  let killTimer = null;
  let ended = false;
  async function end({ code, error }) {
    if (ended) return;
    ended = true;
    clearTimeout(killTimer);
    child = null;
    const failures = failuresIn();
    if (error) {
      state = 'failed';
      result = { text: `The scrape could not start: ${error.message}`, failures: [], retry: null };
      return;
    }
    if (stopping) {
      state = 'stopped';
      result = { text: 'Stopped — nothing changed; the server keeps its data.', failures: [], retry: null };
      return;
    }
    if ((await mtime(dataFile)) === before) {
      state = 'failed';
      result = { text: 'Nothing changed — the server keeps its data.', failures, retry: null };
      return;
    }
    summary = { took: formatDuration(now() - startMs), failures, code };
    await syncFrom('upload');
  }

  const status = () => ({ available: Boolean(sync), state, startedAt, lines: [...lines], result });

  return {
    status,

    async start() {
      if (!sync) return { ...status(), error: 'Refresh needs SYNC_URL and SYNC_KEY in .env.' };
      if (BUSY.has(state)) return status();
      state = 'running';
      lines = [];
      result = null;
      stopping = false;
      ended = false;
      summary = null;
      uploaded = null;
      startMs = now();
      startedAt = new Date().toISOString();
      before = await mtime(dataFile);
      child = run();
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      child.on('error', (error) => { add(`Could not start the scrape: ${error.message}`); end({ error }); });
      child.on('close', (code) => { setImmediate(() => end({ code })); });
      return status();
    },

    stop() {
      if (state === 'running' && child) {
        stopping = true;
        // SIGINT, not SIGTERM: puppeteer installs a SIGTERM handler that closes Chrome but
        // does not exit, and its presence suppresses Node's default exit, so the scrape would
        // carry on. Its SIGINT handler kills Chrome and exits. SIGKILL if it still hasn't ended.
        const target = child;
        target.kill('SIGINT');
        killTimer = setTimeout(() => target.kill('SIGKILL'), killAfterMs);
      }
      return status();
    },

    retry(step) {
      if (state === 'failed' && result?.retry === step && summary) syncFrom(step);
      return status();
    },
  };
}
