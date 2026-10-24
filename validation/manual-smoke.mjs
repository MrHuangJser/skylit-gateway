import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:48175';
const env = await readFile(new URL('../.local/gateway.env', import.meta.url), 'utf8');
const accessToken = env.match(/^GATEWAY_ACCESS_TOKEN=(.+)$/m)?.[1];
assert.ok(accessToken);
const options = { signal: AbortSignal.timeout(20000), redirect: 'manual' };
const health = await fetch(`${origin}/_gateway/health`, options);
assert.equal(health.status, 200);
const entry = await fetch(`${origin}/_gateway/login`, options);
assert.equal(entry.status, 200);
const login = await fetch(`${origin}/_gateway/login`, { ...options, method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }) });
assert.equal(login.status, 204);
const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
assert.ok(cookie);
const access = await fetch(`${origin}/api/access`, { ...options, headers: { Cookie: cookie } });
assert.equal(access.status, 200);
const data = await access.json();
assert.equal(data.application, true);
const logout = await fetch(`${origin}/_gateway/logout`, { ...options, method: 'POST',
  headers: { Cookie: cookie, Origin: origin } });
assert.equal(logout.status, 204);
console.log(JSON.stringify({ origin, loginPageStatus: entry.status, protectedAccessStatus: access.status,
  applicationEnabled: data.application === true, probeSessionLoggedOut: true,
  upstreamCredentialsLogged: false }, null, 2));
