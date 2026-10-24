// Verify only the two pinned PUBLIC static chunks. No auth or private profile is read.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile(new URL('../frontend/manifest.json', import.meta.url), 'utf8'));
const result = { checkedAt: new Date().toISOString(), credentialsUsed: false, assets: [] };
for (const entry of manifest.assets) {
  assert.match(entry.path, /^\/_next\/static\/chunks\/[A-Za-z0-9_-]+\.js$/);
  const response = await fetch(`https://app.skylit.ai${entry.path}`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length; assert.ok(bytes <= 4 * 1024 * 1024);
    chunks.push(chunk);
  }
  const sha256 = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
  result.assets.push({ path: entry.path, bytes, matchesPinnedSource: sha256 === entry.originalSha256 });
}
await writeFile(new URL('./results/black-screen/live-version.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
assert.ok(result.assets.every(asset => asset.matchesPinnedSource), 'Do not deploy patches against an unknown live source');
