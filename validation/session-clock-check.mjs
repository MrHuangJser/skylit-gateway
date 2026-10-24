// Scheduling and consistency booleans only; never output credential or identity values.
import { readFile } from 'node:fs/promises';
const snapshot = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
const profile = JSON.parse(await readFile(new URL('../.local/session/browser-profile.json', import.meta.url), 'utf8'));
const now = Math.floor(Date.now() / 1000);
let identityConsistent = false, advertisedExpiryConsistent = false;
try {
  const claims = JSON.parse(Buffer.from(snapshot.bearerToken.split('.')[1], 'base64url').toString('utf8'));
  identityConsistent = claims.sub === profile.user.id;
  advertisedExpiryConsistent = claims.exp === snapshot.expiresAt;
} catch {}
console.log(JSON.stringify({ hostEpochSeconds: now,
  tokenSecondsRemaining: snapshot.expiresAt - now, snapshotAgeSeconds: now - snapshot.capturedAt,
  profileAgeSeconds: now - profile.capturedAt, identityConsistent, advertisedExpiryConsistent }, null, 2));
