const $ = (q) => document.querySelector(q);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const money = (n, cur) => `$${Math.round(n).toLocaleString('en-US')}${cur && cur !== 'USD' ? ` ${cur}` : ''}`;
const day = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

let rows = [];
// Set when the cruise data couldn't be loaded: then "now" is unknown, not "gone".
let noData = null;
let sortKey = null;
let sortDir = -1;

const COLUMNS = [
  ['Date', (r) => r.s.departureDate],
  ['Line', (r) => r.s.line],
  ['Ship', (r) => r.s.ship],
  ['Itinerary', (r) => r.s.itinerary ?? ''],
  ['Stars', (r) => r.sel.rating ?? 0],
  ['Price then', (r) => r.sel.snapshot.price ?? 0],
  ['Price now', (r) => r.now?.price ?? Infinity],
  ['Views', (r) => r.sel.views],
  ['Last viewed', (r) => r.sel.lastViewed ?? ''],
];

/** The chip's order: rated first, highest first; then most recently viewed. */
const defaultOrder = (a, b) => (b.sel.rating ?? 0) - (a.sel.rating ?? 0)
  || String(b.sel.lastViewed ?? '').localeCompare(String(a.sel.lastViewed ?? ''));

/** One line above the table, for a rating that didn't save. null clears it. */
function note(text) {
  $('#note').textContent = text ?? '';
}

/**
 * Forgets a cruise: its rating and views, in one go. It throws a rating away, so it takes two
 * clicks — "Remove", then "Confirm?" within 4 seconds — with no dialog in between.
 */
function removeButton(r) {
  const b = el('button', { type: 'button', class: 'remove', text: 'Remove', title: 'Forget this cruise: its rating and views' });
  let timer = null;
  const disarm = () => { b.classList.remove('armed'); b.textContent = 'Remove'; };
  b.onclick = async () => {
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = 'Confirm?';
      timer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(timer);
    try {
      const res = await fetch('/api/selections/forget', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: r.sel.sailingId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
    } catch (err) {
      disarm();
      note(`Not removed: ${err.message}`);
      return;
    }
    note(null);
    rows = rows.filter((x) => x !== r);
    draw();
  };
  return b;
}

function starsFor(r) {
  const group = el('div', { class: 'stars', role: 'group', 'aria-label': 'Your rating' });
  const paint = () => [...group.children].forEach((b, i) => {
    const on = i < (r.sel.rating ?? 0);
    b.className = on ? 'star on' : 'star';
    b.textContent = on ? '★' : '☆';
    b.setAttribute('aria-pressed', String(i + 1 === r.sel.rating));
  });
  for (let n = 1; n <= 5; n += 1) {
    const b = el('button', { type: 'button', 'aria-label': `Rate ${n} star${n === 1 ? '' : 's'}` });
    b.onclick = async () => {
      const rating = r.sel.rating === n ? null : n;
      // Show it now; a later click owns the display, and a failed save puts it back.
      const ticket = (r.ticket = (r.ticket ?? 0) + 1);
      const before = r.sel;
      r.sel = { ...r.sel, rating };
      paint();
      try {
        // One save after another per cruise, so the server ends on the last click.
        const send = (r.chain ?? Promise.resolve()).then(() => fetch('/api/selections/rating', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: r.sel.sailingId, rating }),
        }));
        r.chain = send.catch(() => {});
        const res = await send;
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (ticket !== r.ticket) return;
        if (data.selection) r.sel = data.selection;
        else { rows = rows.filter((x) => x !== r); draw(); return; }
        note(null);
      } catch (err) {
        if (ticket !== r.ticket) return;
        r.sel = before;
        note(`Rating not saved: ${err.message}`);
      }
      paint();
    };
    group.append(b);
  }
  paint();
  return group;
}

function draw() {
  // Here, not once at load: clearing a never-viewed cruise's rating removes its row.
  $('#sub').firstChild.textContent = `${rows.length} viewed or rated · `;
  const host = $('#table');
  host.textContent = '';
  if (rows.length === 0) {
    host.append(el('div', { class: 'empty', text: "Nothing here yet — open a cruise's View ↗ or ✈ Flights, or give it stars." }));
    return;
  }
  const getter = sortKey == null ? null : COLUMNS[sortKey][1];
  const sorted = [...rows].sort(getter
    ? (a, b) => { const x = getter(a); const y = getter(b); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; }
    : defaultOrder);

  const head = el('tr', {}, COLUMNS.map(([label], i) => {
    const b = el('button', { type: 'button', text: label });
    if (i === sortKey) b.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
    b.onclick = () => { sortDir = sortKey === i ? -sortDir : 1; sortKey = i; draw(); };
    return el('th', {}, b);
  }).concat(el('th', {})));

  const body = sorted.map((r) => {
    const link = safeUrl(r.s.url);
    const then = r.sel.snapshot.price;
    let nowCell;
    if (!r.now) nowCell = el('span', { class: 'gone', text: noData ? 'Prices unavailable' : 'No longer listed' });
    else {
      const diff = then != null ? Math.round(r.now.price - then) : 0;
      nowCell = el('span', {}, money(r.now.price, r.now.currency),
        diff ? el('div', { class: diff > 0 ? 'up' : 'down', text: `${diff > 0 ? '+' : '−'}${money(Math.abs(diff), r.now.currency)}` }) : null);
    }
    return el('tr', {},
      el('td', { text: day(r.s.departureDate) }),
      el('td', { text: r.s.line }),
      el('td', { text: r.s.ship }),
      el('td', {}, link ? el('a', { href: link, target: '_blank', rel: 'noopener', text: r.s.itinerary ?? 'Cruise' }) : (r.s.itinerary ?? 'Cruise')),
      el('td', {}, starsFor(r)),
      el('td', { class: 'num', text: then != null ? money(then, r.sel.snapshot.currency) : '' }),
      el('td', { class: 'num' }, nowCell),
      el('td', { class: 'num', text: String(r.sel.views) }),
      el('td', { text: day(r.sel.lastViewed) }),
      el('td', {}, removeButton(r)));
  });

  host.append(el('table', {}, el('thead', {}, head), el('tbody', {}, body)));
}

async function boot() {
  const [dres, sres] = await Promise.all([fetch('/api/dataset'), fetch('/api/selections')]);
  const sdata = await sres.json();
  if (!sres.ok) { $('#sub').firstChild.textContent = `Ratings are unavailable: ${sdata.error} · `; return; }
  const ddata = await dres.json().catch(() => ({}));
  const listed = dres.ok ? ddata.sailings : [];
  if (!dres.ok) {
    noData = ddata.error ?? 'The cruise data could not be loaded.';
    $('#nodata').textContent = `Today's prices are unavailable — ${noData}`;
    $('#nodata').hidden = false;
  }
  const byId = new Map(listed.map((s) => [s.id, s]));
  rows = sdata.selections.map((sel) => {
    const now = byId.get(sel.sailingId) ?? null;
    return { sel, now, s: now ?? sel.snapshot };
  });
  draw();
}

boot();
