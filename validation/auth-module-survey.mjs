// Read-only AST survey of saved public assets. Never executes third-party JS.
import { parse } from '../../api-recon/tooling/node_modules/acorn/dist/acorn.mjs';
import { readFile, writeFile } from 'node:fs/promises';
const files = ['3saht1vl84b4q.js', '0rvuravpijnzz.js', '1g_v7ow8b__pg.js'];
const names = new Set(['ClerkProvider', 'SignedIn', 'SignedOut', 'ClerkLoaded', 'ClerkLoading',
  'useAuth', 'useUser', 'useSession', 'useClerk', 'useSignIn', 'useSignUp', 'UserButton',
  'SignInButton', 'SignOutButton', 'useOrganization', 'useOrganizationList', 'usePromisifiedAuth']);
const result = [];
function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) for (const child of value) visit(child, fn);
    else if (value && typeof value === 'object') visit(value, fn);
  }
}
for (const file of files) {
  const text = await readFile(new URL(`../../api-recon/assets/${file}`, import.meta.url), 'utf8');
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const exports = [];
  const imports = new Set();
  visit(ast, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    if (node.callee.property.name === 'i' && node.arguments[0]?.type === 'Literal') {
      const fragment = text.slice(Math.max(0, node.start - 40), Math.min(text.length, node.end + 90));
      if (/useState|createContext|useMemo|useEffect|useSyncExternalStore/.test(fragment)) {
        imports.add(JSON.stringify({ id: node.arguments[0].value, fragment }));
      }
    }
    if (node.callee.property.name !== 's' || node.arguments[0]?.type !== 'ArrayExpression') return;
    const values = node.arguments[0].elements;
    const found = [];
    for (let i = 0; i + 1 < values.length;) {
      const name = values[i++];
      const direct = values[i]?.type === 'Literal' && values[i].value === 0;
      if (direct) i++;
      const binding = values[i++];
      if (name?.type === 'Literal' && names.has(name.value) && binding) {
        found.push({ name: name.value, kind: direct ? 'direct' : 'getter',
          binding: text.slice(binding.start, binding.end).slice(0, 250) });
      }
    }
    if (found.length) exports.push({ offset: node.start, moduleId: node.arguments[1]?.value ?? null,
      contextName: node.callee.object.name, found });
  });
  result.push({ file, exports, nearbyReactImports: [...imports].map(JSON.parse) });
}
await writeFile(new URL('./results/black-screen/auth-export-survey.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
