// The Mac's Refresh button and its progress panel. The button shows only when the server
// says a Refresh is possible (SYNC_URL + SYNC_KEY); the deployed site never shows it.
const $ = (q) => document.querySelector(q);
const BUSY = new Set(['running', 'uploading', 'pulling']);
const LABEL = { running: 'Refreshing…', uploading: 'Uploading…', pulling: 'Copying ratings…' };
let timer = null;
let stopArmed = null;

async function call(method, path, body) {
  const res = await fetch(path, method === 'GET' ? {} : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

function draw(s) {
  $('#refresh').hidden = !s.available;
  $('#refresh').textContent = LABEL[s.state] ?? 'Refresh data';
  const pre = $('#refresh-lines');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = s.lines.join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  const r = s.result;
  const texts = r ? [r.text, ...r.failures.map((f) => `• ${f}`)] : [];
  $('#refresh-result').replaceChildren(...texts.map((t) => Object.assign(document.createElement('div'), { textContent: t })));
  $('#refresh-stop').hidden = s.state !== 'running';
  $('#refresh-retry').hidden = !r?.retry;
  $('#refresh-retry').dataset.step = r?.retry ?? '';
  // New data is on this Mac once the file was written: done, or a failed upload/copy.
  $('#refresh-new').hidden = !(s.state === 'done' || (s.state === 'failed' && r?.retry));
  clearTimeout(timer);
  if (BUSY.has(s.state)) timer = setTimeout(poll, 2000);
}

async function poll() { draw(await call('GET', '/api/refresh')); }

$('#refresh').addEventListener('click', async () => {
  $('#refresh-panel').hidden = false;
  const s = await call('GET', '/api/refresh');
  draw(BUSY.has(s.state) ? s : await call('POST', '/api/refresh'));
});
$('#refresh-hide').addEventListener('click', () => { $('#refresh-panel').hidden = true; });
// Stop throws away up to 25 minutes of scraping: two clicks, as /mine's Remove.
$('#refresh-stop').addEventListener('click', async () => {
  const b = $('#refresh-stop');
  if (!stopArmed) {
    b.textContent = 'Stop? Click again';
    stopArmed = setTimeout(() => { b.textContent = 'Stop'; stopArmed = null; }, 4000);
    return;
  }
  clearTimeout(stopArmed);
  stopArmed = null;
  b.textContent = 'Stop';
  draw(await call('POST', '/api/refresh/stop'));
});
$('#refresh-retry').addEventListener('click', async () => {
  draw(await call('POST', '/api/refresh/retry', { step: $('#refresh-retry').dataset.step }));
});
$('#refresh-new').addEventListener('click', () => location.reload());

// A Refresh already running (another tab, or before a reload) opens the panel.
call('GET', '/api/refresh').then((s) => {
  if (BUSY.has(s.state)) $('#refresh-panel').hidden = false;
  draw(s);
});
