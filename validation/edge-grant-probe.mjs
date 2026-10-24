// Inspect only metadata of a normal authorized edge-cookie grant. Never persist cookie values.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const snapshot = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
assert.ok(snapshot.expiresAt > Math.floor(Date.now() / 1000) + 3);
const response = await fetch('https://app.skylit.ai/api/edge/cookies', {
  method: 'POST', headers: { Authorization: `Bearer ${snapshot.bearerToken}`, 'Content-Type': 'application/json', Origin: 'https://app.skylit.ai' },
  body: '{}', redirect: 'manual', signal: AbortSignal.timeout(20000),
});
const result = { checkedAt: new Date().toISOString(), status: response.status, cookies: [] };
for (const line of response.headers.getSetCookie()) {
  const pieces = line.split(';').map(p => p.trim());
  const name = pieces.shift().split('=', 1)[0];
  const selected = pieces.filter(p => /^(Max-Age|Domain|Path)=|^(Secure|HttpOnly|SameSite=)/i.test(p));
  result.cookies.push({ name, attributes: selected });
}
if ((response.headers.get('content-type') || '').includes('application/json')) {
  const body = await response.json();
  result.ttlSeconds = typeof body.ttlSeconds === 'number' ? body.ttlSeconds : null;
  result.expiresAtPresent = Object.hasOwn(body, 'expiresAt');
}
await writeFile(new URL('./results/black-screen/edge-grant.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
assert.equal(result.status, 200);
