// AST survey of the CURRENT live chunks: find the Turbopack export registrations that
// re-export the Clerk auth surface, so the patches can be regenerated for this build.
// Parses only; vendor code is never executed.
import { parse } from 'acorn';
import { readFile, writeFile } from 'node:fs/promises';

const DIR = new URL('../.local/live-chunks/', import.meta.url);
const TARGETS = ['3ehfb7p2agn0l.js', '44ald-muhquop.js'];
const NAMES = new Set(['ClerkProvider', 'SignedIn', 'SignedOut', 'ClerkLoaded', 'ClerkLoading', 'useAuth',
  'useUser', 'useSession', 'useClerk', 'useSignIn', 'useSignUp', 'UserButton', 'SignInButton', 'SignOutButton',
  'useOrganization', 'useOrganizationList']);

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    if (Array.isArray(value)) for (const child of value) walk(child, fn);
    else if (value && typeof value === 'object') walk(value, fn);
  }
}

for (const file of TARGETS) {
  const text = await readFile(new URL(file, DIR), 'utf8');
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  // Turbopack registers exports as `<expr>.s([...])`; the enclosing function's first
  // parameter of the module factory carries the numeric module id in `,<id>,e=>{` tails.
  const groups = [];
  walk(ast, node => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || callee.property?.name !== 's') return;
    if (node.arguments.length !== 1 || node.arguments[0].type !== 'ArrayExpression') return;
    const names = [];
    for (const el of node.arguments[0].elements) {
      if (el?.type === 'Literal' && typeof el.value === 'string' && NAMES.has(el.value)) names.push(el.value);
    }
    if (!names.length) return;
    // Module id: current builds pass it as the SECOND argument (`e.s([...], 780240)`).
    const idArg = node.arguments[1];
    let moduleId = idArg?.type === 'Literal' && typeof idArg.value === 'number' ? idArg.value : null;
    if (moduleId === null) {
      const tail = text.slice(node.end, node.end + 20).match(/^\s*,\s*(\d{4,9})\s*\)/);
      if (tail) moduleId = Number(tail[1]);
    }
    groups.push({ moduleId, names: [...new Set(names)], offset: node.start });
  });
  const merged = new Map();
  for (const g of groups) {
    if (g.moduleId === null) continue;
    const set = merged.get(g.moduleId) ?? new Set();
    g.names.forEach(n => set.add(n));
    merged.set(g.moduleId, set);
  }
  console.log(`\n=== ${file} (${text.length}B) groups=${groups.length}`);
  for (const [id, set] of merged) console.log(`  module ${id}: ${[...set].join(', ')}`);
  await writeFile(new URL(`${file.replace('.js', '')}-exports.json`, DIR),
    JSON.stringify([...merged].map(([id, set]) => ({ moduleId: id, names: [...set] })), null, 2));
}
