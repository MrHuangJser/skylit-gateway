// Precise AST mapping of the CURRENT live chunks: for every Turbopack export
// registration `X.s([...], <moduleId>)`, list which target auth names it exports.
// Text slicing (regex) proved unreliable: adjacent registrations got merged.
import { parse } from 'acorn';
import { readFile, writeFile, readdir } from 'node:fs/promises';

const DIR = new URL('../.local/live-chunks/', import.meta.url);
const TARGET = ['ClerkProvider', 'SignedIn', 'SignedOut', 'ClerkLoaded', 'ClerkLoading', 'useAuth', 'useUser',
  'useSession', 'useClerk', 'useSignIn', 'useSignUp', 'UserButton', 'SignInButton', 'SignOutButton',
  'useOrganization', 'useOrganizationList'];
// Scan whatever the fetch step downloaded; chunk names change on every upstream build.
const FILES = (await readdir(DIR)).filter(name => name.endsWith('.js'));

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const v of value) walk(v, fn); }
    else if (value && typeof value === 'object') walk(value, fn);
  }
}

const rows = [];
for (const file of FILES) {
  let text;
  try { text = await readFile(new URL(file, DIR), 'utf8'); } catch { continue; }
  if (!TARGET.some(n => text.includes(n))) continue;
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  walk(ast, node => {
    if (node.type !== 'CallExpression' || node.arguments.length !== 2) return;
    const [arr, idArg] = node.arguments;
    if (arr.type !== 'ArrayExpression' || idArg.type !== 'Literal' || typeof idArg.value !== 'number') return;
    const hits = arr.elements
      .filter(el => el?.type === 'Literal' && typeof el.value === 'string' && TARGET.includes(el.value))
      .map(el => el.value);
    if (!hits.length) return;
    rows.push({ file, moduleId: idArg.value, names: [...new Set(hits)], start: node.start, end: node.end });
  });
}

rows.sort((a, b) => b.names.length - a.names.length);
for (const r of rows) console.log(`${r.file}#${r.moduleId} (${r.names.length}) ${r.names.join(', ')}`);
const covered = new Set(rows.flatMap(r => r.names));
console.log('\ncovered', covered.size, '/', TARGET.length, '| missing:', TARGET.filter(n => !covered.has(n)).join(', ') || 'none');
await writeFile(new URL('seam-ast.json', DIR), JSON.stringify({ rows }, null, 2));
