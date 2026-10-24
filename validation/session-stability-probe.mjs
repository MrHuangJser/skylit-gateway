// Functional time-boundary test (not a job poll): sample real protected access across
// multiple normal token rotations. No token, Cookie or user data is written to output.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const origin = 'http://127.0.0.1:48175';
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const accessToken = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
const result = { startedAt: new Date().toISOString(), samples: [], credentialsLogged: false };
let cookie;
try {
  const login = await fetch(`${origin}/_gateway/login`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }), signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 204);
  cookie = login.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie);
  const expiries = new Set();
  for (let sample = 0; sample < 9; sample++) {
    if (sample) await new Promise(resolve => setTimeout(resolve, 10000));
    const response = await fetch(`${origin}/api/access`, {
      headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) });
    // Consume without persisting the private response; record only success/status.
    const data = response.ok ? await response.json() : null;
    const snapshot = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
    expiries.add(snapshot.expiresAt);
    result.samples.push({ at: new Date().toISOString(), status: response.status,
      applicationEnabled: data?.application === true });
  }
  result.distinctAdvertisedExpiries = expiries.size;
  assert.ok(expiries.size >= 2, 'The test must span a real SDK token update');
  assert.ok(result.samples.every(sample => sample.status === 200 && sample.applicationEnabled));
  result.stableAcrossTokenUpdates = true;
} catch (_) {
  result.failure = 'Token-boundary stability assertion failed; raw credentials and identity intentionally not logged.';
  process.exitCode = 1;
} finally {
  if (cookie) await fetch(`${origin}/_gateway/logout`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin }, signal: AbortSignal.timeout(10000) }).catch(() => {});
  result.finishedAt = new Date().toISOString();
  await writeFile(new URL('./results/black-screen/session-stability.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
