// Find every module that exports ClientClerkProvider (the root provider that creates
// the Clerk instance) so all of its import paths can be replaced.
import { readFile, readdir } from 'node:fs/promises';
import { exportsIn } from './generate-auth-patches.mjs';

const DIR = new URL('../.local/live-chunks/', import.meta.url);
const files = (await readdir(DIR)).filter(f => f.endsWith('.js'));
for (const file of files) {
  const src = await readFile(new URL(file, DIR), 'utf8');
  if (!src.includes('ClientClerkProvider')) continue;
  let all;
  try { all = exportsIn(src); } catch { console.log(`${file}: parse error`); continue; }
  const hits = all.filter(e => /ClerkProvider|^useAuth$/.test(e.name));
  if (!hits.length) continue;
  const grouped = new Map();
  for (const h of hits) grouped.set(h.moduleId, [...(grouped.get(h.moduleId) ?? []), h.name]);
  for (const [id, names] of grouped) console.log(`${file}#${id}: ${names.join(', ')}`);
}
