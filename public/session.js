// Shared by the search page and /mine. A 401 means the session ended: go and log in.
// Also shows "Log out" (when the login is on) and the Mac's mirror note (Task 4).
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401) location.assign('/login');
  return res;
};

const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

async function showStatus() {
  const res = await nativeFetch('/api/status');
  if (!res.ok) return;
  const status = await res.json();
  const account = document.querySelector('#account');
  if (status.login && account) {
    const out = document.createElement('a');
    out.href = '/login';
    out.textContent = 'Log out';
    out.addEventListener('click', async (e) => {
      e.preventDefault();
      await nativeFetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      location.assign('/login');
    });
    account.append(out);
  }
  const note = document.querySelector('#mirror-note');
  if (status.mirror && note) {
    note.textContent = status.ratingsCopiedAt
      ? `Ratings copied from the server at ${when(status.ratingsCopiedAt)} — changes here aren't kept`
      : 'Ratings not yet copied from the server — changes here aren\'t kept';
    note.hidden = false;
  }
}
showStatus();
