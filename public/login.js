const form = document.querySelector('#login');
const error = document.querySelector('#error');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.querySelector('#password').value }),
  });
  if (res.ok) { location.assign('/'); return; }
  const data = await res.json().catch(() => ({}));
  error.textContent = data.error ?? `Login failed (${res.status}).`;
});
