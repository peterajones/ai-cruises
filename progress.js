/**
 * What a scrape prints while it runs. Before this, a line printed only when it finished,
 * so Cunard's ~9 minutes of requests were silent and a working scrape looked stuck.
 *
 * Adapters report through an onProgress(text) callback and never print; scrape.js owns
 * this reporter. In a terminal, progress rewrites one line in place. Into a log file it
 * prints at most every THROTTLE_MS, so a log doesn't fill with hundreds of lines.
 */
const THROTTLE_MS = 15_000;
const CLEAR = '\r\x1b[K'; // back to the start of the line, and erase it

export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function createReporter({ stream = process.stdout, now = Date.now } = {}) {
  const tty = Boolean(stream.isTTY);
  const runStart = now();
  const started = {};
  let showing = null;   // the progress text on screen (terminal only)
  let lastPrint = 0;

  const clear = () => {
    if (showing === null) return;
    stream.write(CLEAR);
    showing = null;
  };

  // Overwrites the progress line, if one is showing, rather than leaving it above the text.
  const line = (text) => {
    stream.write(`${showing !== null ? CLEAR : ''}${text}\n`);
    showing = null;
  };

  return {
    start(name) {
      clear();
      started[name] = now();
      lastPrint = now();
      stream.write(`${name}: fetching…\n`);
    },

    progress(name, text) {
      const full = `${name}: ${text}`;
      if (tty) {
        stream.write(`${CLEAR}${full}`);
        showing = full;
        return;
      }
      if (now() - lastPrint < THROTTLE_MS) return;
      lastPrint = now();
      stream.write(`${full}\n`);
    },

    /** A message during a line's fetch; the progress line comes back on the next update. */
    log(text) {
      line(text);
    },

    end(name, summary) {
      const took = formatDuration(now() - (started[name] ?? runStart));
      line(`${name}: ${summary} (${took})`);
    },

    /** Before a failure is printed, so it doesn't land on the end of a progress line. */
    clear,

    done() {
      clear();
      stream.write(`Done in ${formatDuration(now() - runStart)}\n`);
    },
  };
}
