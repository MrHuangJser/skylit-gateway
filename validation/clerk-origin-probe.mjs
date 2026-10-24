// Anonymous, fixed URL differential: change only Origin; no user cookie/token is sent.
import { writeFile } from 'node:fs/promises';
const result = { observedAt: new Date().toISOString(), credentialFree: true, controls: [] };
for (const origin of ['http://127.0.0.1:48175', 'https://app.skylit.ai']) {
  const response = await fetch('https://clerk.skylit.ai/v1/client', {
    headers: { Origin: origin, Accept: 'application/json' },
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  const json = await response.json();
  result.controls.push({ origin, status: response.status,
    errorCodes: Array.isArray(json.errors) ? json.errors.map(e => String(e.code)) : [],
    responseObject: typeof json.response?.object === 'string' ? json.response.object : null });
}
result.originRestrictionObserved = result.controls[0].errorCodes.includes('origin_invalid')
  && result.controls[1].status === 200;
await writeFile(new URL('./results/black-screen/origin-controls.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.originRestrictionObserved) process.exitCode = 1;
