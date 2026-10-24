// Extract scheduling metadata only; never output the runtime credential.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const snapshot = JSON.parse(await readFile(new URL('../.local/session/snapshot.json', import.meta.url), 'utf8'));
if (!Number.isSafeInteger(snapshot.expiresAt) || !Number.isSafeInteger(snapshot.capturedAt)) {
  throw new Error('No supported session snapshot metadata');
}
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
const meta = { recordedAt: new Date().toISOString(),
  firstAdvertisedExpiry: snapshot.expiresAt, firstCaptureTime: snapshot.capturedAt,
  note: 'Expiry claim is scheduling metadata, not local JWT signature verification.' };
await writeFile(new URL('./results/session-window.json', import.meta.url), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
