// Locate every module that re-exports one of the 16 Clerk bindings the adapter owns,
// across the CURRENT live chunks. Text-based scan of Turbopack `e.s([...], <id>)`
// registrations; vendor code is never executed.
import { readFile, writeFile } from 'node:fs/promises';

const DIR = new URL('../.local/live-chunks/', import.meta.url);
const FILES = ['3ehfb7p2agn0l.js', '44ald-muhquop.js', '2r4cegqs6anok.js', '03idx7809i9wg.js'];
const TARGET = ['ClerkProvider', 'SignedIn', 'SignedOut', 'ClerkLoaded', 'ClerkLoading', 'useAuth', 'useUser',
  'useSession', 'useClerk', 'useSignIn', 'useSignUp', 'UserButton', 'SignInButton', 'SignOutButton',
  'useOrganization', 'useOrganizationList'];

const byModule = new Map();
for (const file of FILES) {
  let text;
  try { text = await readFile(new URL(file, DIR), 'utf8'); } catch { continue; }
  const re = /\.s\(\[/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const close = text.indexOf('],', start);
    if (close < 0) continue;
    const idm = text.slice(close, close + 20).match(/^],(\d+)\)/);
    if (!idm) continue;
    const id = Number(idm[1]);
    const body = text.slice(start + 4, close);
    const names = [...body.matchAll(/"([A-Za-z_$][\w$]*)",/g)].map(x => x[1]).filter(n => TARGET.includes(n));
    if (!names.length) continue;
    const key = `${file}#${id}`;
    const entry = byModule.get(key) ?? { file, moduleId: id, names: new Set(), start, end: close + idm[0].length };
    names.forEach(n => entry.names.add(n));
    byModule.set(key, entry);
  }
}
const rows = [...byModule.values()].map(e => ({ ...e, names: [...e.names] }));
rows.sort((a, b) => b.names.length - a.names.length);
for (const r of rows) console.log(`${r.file} module=${r.moduleId} (${r.names.length}) ${r.names.join(', ')}`);
const covered = new Set(rows.flatMap(r => r.names));
console.log('\ncovered:', covered.size, '/', TARGET.length,
  '| missing:', TARGET.filter(n => !covered.has(n)).join(', ') || 'none');
await writeFile(new URL('seam-map.json', DIR), JSON.stringify({ target: TARGET, modules: rows }, null, 2));
