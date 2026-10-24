// List every export of a module id in the current chunks (to find the provider the app
// actually uses when Clerk still initialises).
import { readFile } from 'node:fs/promises';
import { exportsIn } from './generate-auth-patches.mjs';

const queries = [
  ['44ald-muhquop.js', [441895, 927534, 496136]],
  ['3ehfb7p2agn0l.js', [338703, 965389, 192448]],
];
for (const [file, ids] of queries) {
  const src = await readFile(new URL(`../.local/live-chunks/${file}`, import.meta.url), 'utf8');
  const all = exportsIn(src);
  for (const id of ids) {
    const names = all.filter(e => e.moduleId === id).map(e => e.name);
    console.log(`${file}#${id}: ${names.join(', ') || '(none)'}`);
  }
}
