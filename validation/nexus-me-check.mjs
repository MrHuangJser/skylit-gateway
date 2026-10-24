// Read-only: does the real account already carry nexusDisclaimerAcceptedAt?
// Prints only field names and booleans, never values that identify the account.
import { readFile } from 'node:fs/promises';
const snap = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
const r = await fetch('https://app.skylit.ai/api/nexus/users/me', { headers: { Authorization: `Bearer ${snap.bearerToken}`, Accept: 'application/json' } });
const body = await r.json().catch(() => null);
console.log('status', r.status);
if (body && typeof body === 'object') {
  console.log('top-level keys:', Object.keys(body).sort().join(', '));
  console.log('nexusDisclaimerAcceptedAt present:', Boolean(body.nexusDisclaimerAcceptedAt));
  console.log('username present:', Boolean(body.username && String(body.username).trim()));
}
