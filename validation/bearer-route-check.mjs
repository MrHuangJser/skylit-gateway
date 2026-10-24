// Does the normal intermediary Bearer let the upstream render protected app pages?
// Prints only status codes and redirect hosts. The token itself is never printed.
import { readFile } from 'node:fs/promises';
const snap = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
const paths = (process.env.ROUTES || '/talon,/nexus/leaderboard,/nexus/settings,/portal,/support,/tempest').split(',');
const headers = { Authorization: `Bearer ${snap.bearerToken}`, Accept: 'text/html',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
for (const p of paths) {
  const r = await fetch(`https://app.skylit.ai${p}`, { headers, redirect: 'manual' });
  const loc = r.headers.get('location');
  console.log(`${p.padEnd(22)} with-bearer=${r.status}${loc ? ' -> ' + new URL(loc, 'https://app.skylit.ai').host : ''}`);
}
