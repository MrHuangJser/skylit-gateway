// Bounded, fixed-origin page-auth diagnostic; no response body/credential is persisted.
import { readFile, writeFile } from 'node:fs/promises';
const snapshot = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
if (snapshot.expiresAt <= Math.floor(Date.now() / 1000) + 3) throw new Error('Fresh intermediary snapshot required');
const result = { time: new Date().toISOString(), page: '/atlas', observations: [] };
for (const [name, headers] of [
  ['anonymous-page', {}],
  ['normal-session-bearer-page', { Authorization: `Bearer ${snapshot.bearerToken}` }],
]) {
  try {
    const response = await fetch('https://app.skylit.ai/atlas', {
      headers, redirect: 'manual', signal: AbortSignal.timeout(30000),
    });
    const location = response.headers.get('location');
    const destination = location ? new URL(location, 'https://app.skylit.ai/atlas') : null;
    const body = await response.text();
    result.observations.push({ name, status: response.status,
      clerkAuthStatus: response.headers.get('x-clerk-auth-status'),
      redirectOrigin: destination?.origin || null,
      redirectPath: destination?.pathname || null,
      setCookiePresent: response.headers.has('set-cookie'),
      bodyContainsCurrentBearer: body.includes(snapshot.bearerToken),
      bodyCharacters: body.length,
    });
  } catch (_) {
    result.observations.push({ name, failed: true });
    process.exitCode = 1;
  }
}
result.note = 'Page HTTP authentication is not browser SDK initialization or full app compatibility.';
await writeFile(new URL('./results/page-auth-diagnostic.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
