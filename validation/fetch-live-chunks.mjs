// Download the current public frontend chunks (HTML + JS only, no auth) and report
// which ones export the Clerk auth surface the gateway needs to replace.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../.local/live-chunks/', import.meta.url));
await mkdir(OUT, { recursive: true });
const NAMES = ['ClerkProvider', 'SignedIn', 'SignedOut', 'ClerkLoaded', 'ClerkLoading', 'useAuth', 'useUser',
  'useSession', 'useClerk', 'useSignIn', 'useSignUp', 'UserButton', 'SignInButton', 'SignOutButton',
  'useOrganization', 'useOrganizationList'];

const html = await (await fetch('https://app.skylit.ai/', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36', Accept: 'text/html' },
  signal: AbortSignal.timeout(30000) })).text();
await writeFile(`${OUT}index.html`, html);
const paths = [...new Set([...html.matchAll(/_next\/static\/chunks\/[A-Za-z0-9_-]+\.js/g)].map(m => m[0]))].sort();
console.log(`html bytes=${html.length} chunks=${paths.length}`);

const found = [];
const queue = [...paths];
async function worker() {
  while (queue.length) {
    const path = queue.shift();
    const res = await fetch(`https://app.skylit.ai/${path}`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (!res || res.status !== 200) { console.log(`skip ${path} ${res?.status ?? 'err'}`); continue; }
    const text = await res.text();
    const name = path.split('/').pop();
    await writeFile(`${OUT}${name}`, text);
    const hits = NAMES.filter(n => text.includes(n));
    if (hits.length) {
      found.push({ name, bytes: text.length, hits });
      console.log(`${name} ${text.length}B hits=${hits.join(',')}`);
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
await writeFile(`${OUT}report.json`, JSON.stringify({ chunks: paths.length, found }, null, 2));
console.log('=== candidates with auth surface:', found.length);
