/* Client-side password gate for the Support Hub.
   IMPORTANT — read before relying on this: this is a static GitHub Pages site with
   no backend, so this can only ever be a deterrent against casual access to the
   page itself. It does NOT protect data/support-clients.json, which remains
   directly fetchable by anyone who has or guesses that URL, gate or no gate — and
   it can be bypassed entirely by anyone comfortable with browser dev tools. If the
   client data here needs genuine protection, the real options are making the
   GitHub repo private (Pages then requires a paid GitHub plan) or fronting it with
   something like Cloudflare Access. This gate is not a substitute for either.

   The password itself isn't stored in plain text here — only its SHA-256 hash —
   so at least casually viewing this file's source doesn't hand someone the
   password directly. That's a minor speed bump, not real protection either. */

const GATE_PASSWORD_HASH = '67505031c4be9c5ca4efaeaaeced51c17f992a05a3ed7c874f17ded9ed0ace05';
const GATE_STORAGE_KEY = 'supportHubUnlocked';

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function unlockApp() {
  document.getElementById('gate-overlay').style.display = 'none';
  document.getElementById('app-content').style.display = 'block';
}

async function checkGatePassword() {
  const input = document.getElementById('gatePassword');
  const errorEl = document.getElementById('gateError');
  const hash = await sha256(input.value);
  if (hash === GATE_PASSWORD_HASH) {
    localStorage.setItem(GATE_STORAGE_KEY, '1');
    unlockApp();
  } else {
    errorEl.textContent = 'Incorrect password.';
    input.value = '';
    input.focus();
  }
}

document.getElementById('gatePassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') checkGatePassword();
});

// Already unlocked this browser previously — skip straight in.
if (localStorage.getItem(GATE_STORAGE_KEY) === '1') {
  unlockApp();
}
