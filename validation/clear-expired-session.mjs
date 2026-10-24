// Cleanup only after the intermediary helper has stopped. Refuses to clear a live snapshot.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const local = await realpath(fileURLToPath(new URL('../.local/', import.meta.url)));
const dir = await realpath(resolve(local, 'session'));
assert.equal(dirname(dir), local);
const target = resolve(dir, 'snapshot.json');
const temp = resolve(dir, `cleared-${process.pid}.tmp`);
assert.equal(dirname(target), dir);
assert.equal(dirname(temp), dir);
const value = JSON.parse(await readFile(target, 'utf8'));
assert.ok(value.expiresAt < Math.floor(Date.now() / 1000), 'Refusing to clear a currently valid snapshot');
await writeFile(temp, JSON.stringify({ bearerToken: '', expiresAt: 0, capturedAt: 0 }), { flag: 'wx', mode: 0o600 });
// Both absolute targets were verified above; replace only our expired runtime snapshot.
await rename(temp, target);
await writeFile(resolve(local, 'session-exporter-status.json'), JSON.stringify({
  state: 'expired-snapshot-cleared', checkedAt: new Date().toISOString(), credentialsLogged: false,
}, null, 2));
console.log('Expired intermediary token cleared. Dedicated browser profile retained; no credentials logged.');
