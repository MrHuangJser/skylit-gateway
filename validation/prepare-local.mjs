import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../.local/', import.meta.url));
await mkdir(dir, { recursive: true });
const file = `${dir}/gateway.env`;
try {
  await access(file);
  console.log('Local configuration already exists; left unchanged.');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  await writeFile(file, `GATEWAY_ACCESS_TOKEN=${randomBytes(32).toString('hex')}\nPUBLIC_ORIGIN=http://127.0.0.1:48173\nCOOKIE_SECURE=false\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created ignored local-only gateway configuration (no upstream credentials).');
}
