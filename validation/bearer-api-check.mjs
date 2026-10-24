// For each read API seen failing with 401, check whether the normal Bearer is accepted.
// Prints only status codes. The token itself is never printed.
import { readFile } from 'node:fs/promises';
const snap = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
const paths = ['/siren/rules', '/agent-gateway/agenthub/tempest-alerts', '/fs/api/alerts', '/fs/api/opra-agreement',
  '/fs/api/tracked-contracts', '/fs/api/saved-trades', '/api/stages/capabilities', '/api/stages/bookmarks',
  '/api/stages/watch-progress', '/api/stages/recaps', '/api/stages/reviews/mine', '/api/nexus/academy/certifications',
  // Optional: a real presenter id from a Stages page, passed in instead of hardcoded.
  ...(process.env.STAGE_USER_ID ? [`/api/stages/users/${encodeURIComponent(process.env.STAGE_USER_ID)}/discord`] : [])];
for (const p of paths) {
  const r = await fetch(`https://app.skylit.ai${p}`, { headers: { Authorization: `Bearer ${snap.bearerToken}`, Accept: 'application/json' }, redirect: 'manual' });
  console.log(`${String(r.status).padEnd(4)} ${p}`);
}
